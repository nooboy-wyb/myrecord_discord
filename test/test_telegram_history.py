import asyncio
import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "telegram"))

from archive import Archive
from history import history, parse_until, verify_message


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.folder = Path(self.temporary.name)
        self.until = datetime(2026, 11, 25, 13, 0, tzinfo=timezone.utc)
        self.args = SimpleNamespace(until=self.until.isoformat(), hours=24, topic=None, channel="-100123")
        self.entity = SimpleNamespace(title="Test", forum=False)
        self.options = None
        self.topic_failure = None

    def tearDown(self):
        self.temporary.cleanup()

    def message(self, number, date=None, text=None, topic=None):
        return SimpleNamespace(id=number, date=date or self.until-timedelta(hours=1),
                               text=text or f"message {number}", topic=topic)

    def normalize(self, entity, message):
        return {"source": "telegram", "peer_id": self.args.channel, "channel_name": entity.title,
                "message_id": str(message.id), "source_timestamp": message.date.isoformat(),
                "body_raw": message.text, "edit_timestamp": None, "grouped_id": None,
                "topic_id": str(message.topic) if message.topic is not None else None, "attachments": []}

    async def save(self, client, archive, entity, message):
        return archive.save(self.normalize(entity, message))[1]

    def run_history(self, messages, save=None):
        test = self
        class Client:
            def iter_messages(self, entity, **options):
                test.options = options
                async def iterate():
                    for message in messages:
                        if isinstance(message, BaseException):
                            raise message
                        yield message
                return iterate()

            async def __call__(self, request):
                if test.topic_failure:
                    raise test.topic_failure
                return SimpleNamespace(topics=[SimpleNamespace(id=test.args.topic, title="Selected topic")])

        with contextlib.redirect_stdout(io.StringIO()):
            return asyncio.run(history(Client(), self.folder, self.args, save or self.save,
                                       self.entity, self.normalize))

    def latest(self):
        return json.loads(next((self.folder/"audits").glob("*-latest.json")).read_text(encoding="utf-8"))

    def test_scans_more_than_1000_messages_without_limit_and_reconciles_all_rows(self):
        messages = [self.message(number) for number in range(1001, 0, -1)]
        result = self.run_history(messages)
        self.assertIsNone(self.options["limit"])
        self.assertEqual(self.options["offset_date"], self.until)
        self.assertEqual((result["read"], result["verified"]), (1001, 1001))
        self.assertEqual(result["boundary"]["reason"], "api_exhausted")
        self.assertEqual(result["status"], "passed")

    def test_time_boundaries_include_start_exclude_end_and_preserve_evidence(self):
        start = self.until-timedelta(hours=24)
        result = self.run_history([self.message(5, self.until), self.message(4),
                                   self.message(3, start), self.message(2, start-timedelta(seconds=1))])
        self.assertEqual([message["message_id"] for message in result["messages"]], ["3", "4"])
        self.assertEqual(result["boundary"]["message_id"], "2")
        self.assertTrue(result["scan_complete_to_boundary"])

    def test_fixed_window_repeat_is_idempotent_and_reports_source_changes(self):
        first = self.run_history([self.message(2), self.message(1)])
        repeated = self.run_history([self.message(2), self.message(1)])
        self.assertEqual(repeated["inserted"], 0)
        self.assertTrue(repeated["same_as_previous_scan"])
        self.assertNotEqual(first["audit_file"], repeated["audit_file"])
        changed = self.run_history([self.message(3), self.message(2, text="edited")])
        self.assertEqual(changed["source_changes"], {"added": ["3"], "no_longer_returned": ["1"], "changed": ["2"]})
        with ArchiveContext(self.folder) as archive:
            self.assertEqual(archive.summary(self.args.channel)["messages"], 3)
            self.assertEqual(archive.summary(self.args.channel)["versions"], 4)

    def test_interruption_keeps_partial_rows_and_never_reports_complete(self):
        with self.assertRaises(ConnectionError):
            self.run_history([self.message(1), ConnectionError("test")])
        audit = self.latest()
        self.assertEqual(audit["status"], "failed")
        self.assertFalse(audit["scan_complete_to_boundary"])
        self.assertEqual(audit["verified"], 1)
        self.assertTrue(Path(audit["audit_file"]).is_file())

    def test_missing_database_write_fails_audit(self):
        async def broken_save(*args):
            return False
        with self.assertRaises(RuntimeError):
            self.run_history([self.message(1)], broken_save)
        self.assertEqual(self.latest()["status"], "verification_failed")
        self.assertEqual(self.latest()["errors"][0]["error"], "message_missing")

    def test_forum_uses_native_topic_query_and_rejects_other_topics(self):
        self.args.topic = 123
        self.entity.forum = True
        selected = self.run_history([self.message(1, topic=123)])
        self.assertEqual(self.options["reply_to"], 123)
        self.assertEqual(selected["topic_title"], "Selected topic")
        with self.assertRaises(ValueError):
            self.run_history([self.message(2, topic=999)])
        self.assertEqual(self.latest()["status"], "failed")

    def test_image_file_and_hash_are_verified(self):
        expected = self.normalize(self.entity, self.message(1))
        expected["attachments"] = [{"media_id": "456", "kind": "image", "mime_type": "image/png", "size": 4}]
        with ArchiveContext(self.folder) as archive:
            row_id, _ = archive.save(expected)
            attachment = archive.attachment_rows(row_id)[0]
            image = self.folder/"image.png"
            image.write_bytes(b"test")
            digest = hashlib.sha256(b"test").hexdigest()
            archive.attachment_result(attachment["id"], "saved", image, digest)
            self.assertEqual(verify_message(archive, expected)[2], [])
            image.write_bytes(b"corrupted")
            self.assertIn("image_hash_mismatch", verify_message(archive, expected)[2])
            image.unlink()
            self.assertIn("image_file_missing", verify_message(archive, expected)[2])

    def test_timezone_is_required_and_normalized(self):
        with self.assertRaises(ValueError):
            parse_until("2026-11-25T13:00:00")
        self.assertEqual(parse_until("2026-11-25T21:00:00+08:00"), self.until)

    def test_failed_attempt_does_not_replace_last_successful_comparison(self):
        first = self.run_history([self.message(1)])
        with self.assertRaises(ConnectionError):
            self.run_history([ConnectionError("test")])
        recovered = self.run_history([self.message(1)])
        self.assertEqual(recovered["previous_successful_run_id"], first["run_id"])
        self.assertTrue(recovered["same_as_previous_scan"])

    def test_topic_permission_failure_has_an_audit_and_no_completion_claim(self):
        self.args.topic = 123
        self.entity.forum = True
        self.topic_failure = PermissionError("test")
        with self.assertRaises(PermissionError):
            self.run_history([])
        self.assertEqual(self.latest()["status"], "failed")
        self.assertFalse(self.latest()["scan_complete_to_boundary"])

    def test_real_normalizer_preserves_thread_id_and_reply_parent(self):
        from collector import normalize
        from telethon import types

        entity = types.Channel(id=123, title="Test", photo=types.ChatPhotoEmpty(),
                               date=self.until, megagroup=True, forum=True)
        message = SimpleNamespace(id=200, photo=None, document=None, date=self.until,
                                  edit_date=None, grouped_id=None, raw_text="test",
                                  reply_to=types.MessageReplyHeader(reply_to_msg_id=199,
                                                                   reply_to_top_id=123, forum_topic=True))
        result = normalize(entity, message)
        self.assertEqual(result["topic_id"], "123")
        self.assertEqual(result["reply_to_message_id"], "199")


class ArchiveContext:
    def __init__(self, folder):
        self.archive = Archive(folder)

    def __enter__(self):
        return self.archive

    def __exit__(self, *args):
        self.archive.close()


if __name__ == "__main__":
    unittest.main()
