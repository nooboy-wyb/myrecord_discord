import asyncio
import hashlib
import contextlib
import io
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "telegram"))
from archive import Archive
from monitor import monitor, monitor_lock, monitor_round, read_sources


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.folder = Path(self.temporary.name)
        self.until = datetime(2026, 11, 25, 13, tzinfo=timezone.utc)
        self.source = {"enabled": True, "peer_id": "-1001", "topic_id": 13, "topic_title": "Topic",
                       "target": "TG1", "enabled_at": (self.until-timedelta(days=1)).isoformat()}
        self.options = []

    def tearDown(self):
        self.temporary.cleanup()

    def message(self, number, topic=13):
        return SimpleNamespace(id=number, date=self.until-timedelta(seconds=10), topic=topic)

    def normalize(self, entity, message):
        return {"peer_id": entity.peer_id, "channel_name": "Test", "message_id": str(message.id),
                "source_timestamp": message.date.isoformat(), "edit_timestamp": None, "grouped_id": None,
                "body_raw": f"message {message.id}", "topic_id": str(message.topic), "attachments": []}

    async def save(self, client, archive, entity, message):
        return archive.save(self.normalize(entity, message))[1]

    def round(self, messages, sources=None, save=None, until=None):
        owner = self
        class Client:
            def iter_messages(self, entity, **options):
                owner.options.append(options)
                async def iterate():
                    for item in messages.get(entity.peer_id, []):
                        if isinstance(item, Exception):
                            raise item
                        yield item
                return iterate()
        async def resolve(client, peer):
            return SimpleNamespace(peer_id=peer)
        async def validate(*args):
            return None
        return asyncio.run(monitor_round(Client(), self.folder, sources or [self.source], save or self.save,
                                         self.normalize, resolve, validate, until or self.until))

    def test_unlimited_scan_topic_isolation_and_repeat_verification(self):
        messages = {"-1001": [self.message(number) for number in range(1001, 0, -1)]}
        result = self.round(messages)["sources"][0]
        self.assertEqual((result["read"], result["verified"], result["inserted"]), (1001, 1001, 1001))
        self.assertIsNone(self.options[0]["limit"])
        self.assertEqual(self.options[0]["reply_to"], 13)
        repeated = self.round(messages)["sources"][0]
        self.assertEqual(repeated["inserted"], 0)
        self.assertTrue(repeated["scan_complete_to_boundary"])

    def test_interrupted_scan_retains_checkpoint_and_recovers_entire_outage(self):
        self.round({"-1001": [self.message(1)]})
        later = self.until+timedelta(hours=4)
        interrupted = self.round({"-1001": [self.message(2), ConnectionError()]}, until=later)
        self.assertEqual(interrupted["sources"][0]["status"], "error")
        archive = Archive(self.folder)
        try:
            checkpoint = archive.connection.execute("SELECT scan_until FROM telegram_monitor_state").fetchone()[0]
            self.assertEqual(checkpoint, self.until.isoformat())
        finally:
            archive.close()
        recovered = self.round({"-1001": [self.message(3), self.message(2), self.message(1)]}, until=later)
        self.assertEqual(recovered["sources"][0]["read"], 3)
        self.assertEqual(recovered["sources"][0]["inserted"], 1)

    def test_bad_source_does_not_block_other_source_or_advance_its_checkpoint(self):
        second = {**self.source, "peer_id": "-1002"}
        result = self.round({"-1001": [PermissionError()], "-1002": [self.message(1)]}, [self.source, second])
        self.assertEqual([item["status"] for item in result["sources"]], ["error", "ok"])
        self.assertFalse(result["sources"][0]["scan_complete_to_boundary"])
        wrong = self.round({"-1001": [self.message(2, topic=99)]})
        self.assertEqual(wrong["sources"][0]["status"], "error")
        missing = self.round({"-1001": [self.message(2)]}, save=self.no_save)
        self.assertEqual(missing["sources"][0]["status"], "error")

    def test_whole_peer_includes_messages_from_every_topic(self):
        source = {**self.source, "topic_id": None, "topic_title": None}
        result = self.round({"-1001": [self.message(2, topic=99), self.message(1)]}, [source])
        self.assertEqual(result["sources"][0]["status"], "ok")
        self.assertEqual(result["sources"][0]["verified"], 2)
        self.assertNotIn("reply_to", self.options[0])

    async def no_save(self, *args):
        return False

    def test_empty_scan_persists_heartbeat_and_configuration_rejects_overlap(self):
        self.assertEqual(self.round({})["sources"][0]["read"], 0)
        status = json.loads((self.folder/"monitor-status.json").read_text())
        self.assertEqual(status["sources"][0]["scan_until"], self.until.isoformat())
        self.assertEqual(status["phase"], "idle")
        self.assertIn("round_started_at", status)
        self.assertIn("round_finished_at", status)
        self.assertIn("finished_at", status["sources"][0])
        file = self.folder/"sources.json"
        file.write_text(json.dumps({"sources": [self.source]}))
        self.assertEqual(len(read_sources(file)), 1)
        file.write_text(json.dumps({"sources": [self.source, {**self.source, "topic_id": None}]}))
        with self.assertRaises(ValueError):
            read_sources(file)
        file.write_text(json.dumps({"sources": [{**self.source, "enabled_at": "2026-11-25T00:00:00"}]}))
        with self.assertRaises(ValueError):
            read_sources(file)

    def test_duplicate_monitor_is_rejected_and_lock_is_released(self):
        with monitor_lock(self.folder):
            with self.assertRaises(OSError):
                with monitor_lock(self.folder):
                    self.fail("second monitor acquired lock")
        with monitor_lock(self.folder):
            pass

    def test_corrupted_or_missing_image_is_downloaded_again(self):
        from collector import save_message
        archive = Archive(self.folder)
        record = self.normalize(SimpleNamespace(peer_id="-1001"), self.message(1))
        record["attachments"] = [{"media_id": "7", "kind": "image", "mime_type": "image/jpeg", "size": 4}]
        row_id, _ = archive.save(record)
        image = self.folder/"original.jpg"
        image.write_bytes(b"broken")
        archive.attachment_result(archive.attachment_rows(row_id)[0]["id"], "saved", image, hashlib.sha256(b"good").hexdigest())
        calls = []
        class Client:
            async def download_media(self, message, file):
                calls.append(file)
                Path(file).write_bytes(b"good")
                return file
        try:
            with patch("collector.normalize", return_value=record):
                asyncio.run(save_message(Client(), archive, None, None))
                attachment = archive.attachment_rows(row_id)[0]
                self.assertEqual(Path(attachment["local_path"]).read_bytes(), b"good")
                asyncio.run(save_message(Client(), archive, None, None))
                self.assertEqual(len(calls), 1)
                Path(attachment["local_path"]).unlink()
                asyncio.run(save_message(Client(), archive, None, None))
                self.assertEqual(len(calls), 2)
        finally:
            archive.close()

    def test_initial_network_failure_retries_without_relogin(self):
        file = self.folder/"sources.json"
        file.write_text('{"sources": []}')
        clock = [0.0]
        class Client:
            attempts = 0
            connected = False
            def is_connected(self):
                return self.connected
            async def connect(self):
                self.attempts += 1
                if self.attempts == 1:
                    raise ConnectionError()
                self.connected = True
            async def is_user_authorized(self):
                return True
        async def sleep(seconds):
            clock[0] += 0.6
        client = Client()
        with patch("monitor.time.monotonic", side_effect=lambda: clock[0]), patch("monitor.asyncio.sleep", side_effect=sleep), contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(monitor(client, self.folder, SimpleNamespace(config=file, seconds=1),
                                self.save, self.normalize, None))
        self.assertEqual(client.attempts, 2)
        self.assertEqual(json.loads((self.folder/"monitor-status.json").read_text())["sources"], [])

    def test_source_errors_preserve_time_and_sanitized_description(self):
        result = self.round({"-1001": [ConnectionError("proxy http://user:password@proxy.invalid:80 token=private disconnected")]})
        detail = result["sources"][0]
        self.assertEqual(detail["error"], "ConnectionError")
        self.assertIn("error_at", detail)
        self.assertIn("disconnected", detail["error_message"])
        self.assertNotIn("proxy.invalid", detail["error_message"])
        self.assertNotIn("private", detail["error_message"])

    def test_scan_start_is_visible_before_a_long_source_request(self):
        async def resolve(client, peer):
            current = json.loads((self.folder / "monitor-status.json").read_text())
            self.assertEqual(current["phase"], "scanning")
            self.assertEqual(current["sources"][0]["status"], "scanning")
            self.assertIn("last_progress_at", current["sources"][0])
            raise ConnectionError("simulated slow source")

        result = asyncio.run(monitor_round(None, self.folder, [self.source], self.save, self.normalize, resolve, until=self.until))
        self.assertEqual(result["sources"][0]["error"], "ConnectionError")


if __name__ == "__main__":
    unittest.main()
