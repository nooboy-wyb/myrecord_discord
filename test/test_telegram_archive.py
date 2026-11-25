import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "telegram"))

from archive import Archive
from secure_store import read_secret, write_secret


class TelegramArchiveTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.archive = Archive(self.directory.name)
        self.message = {"source": "telegram", "peer_id": "-1001234567890", "message_id": "42",
                        "channel_name": "Test channel", "source_timestamp": "2026-11-25T03:00:00+00:00",
                        "edit_timestamp": None, "grouped_id": None, "body_raw": "Original message",
                        "attachments": [{"media_id": "123", "kind": "image", "mime_type": "image/jpeg", "size": 100}]}

    def tearDown(self):
        self.archive.close()
        self.directory.cleanup()

    def test_repeated_capture_keeps_one_version_and_saved_attachment(self):
        row_id, inserted = self.archive.save(self.message)
        self.assertTrue(inserted)
        attachment = self.archive.attachment_rows(row_id)[0]
        self.archive.attachment_result(attachment["id"], "saved", "image.jpg", "digest")
        repeated_id, inserted = self.archive.save(self.message)
        self.assertFalse(inserted)
        self.assertEqual(row_id, repeated_id)
        self.assertEqual(self.archive.attachment_rows(row_id)[0]["status"], "saved")

    def test_same_message_number_in_different_channels_is_independent(self):
        self.archive.save(self.message)
        other = {**self.message, "peer_id": "-1009876543210"}
        self.archive.save(other)
        self.assertEqual(self.archive.summary(self.message["peer_id"])["messages"], 1)
        self.assertEqual(self.archive.summary(other["peer_id"])["messages"], 1)

    def test_edit_preserves_original_text_as_separate_version(self):
        original_id, _ = self.archive.save(self.message)
        edited_id, inserted = self.archive.save({**self.message, "body_raw": "Edited message",
                                               "edit_timestamp": "2026-11-25T03:02:00+00:00"})
        self.assertTrue(inserted)
        self.assertNotEqual(original_id, edited_id)
        original = self.archive.connection.execute("SELECT body_raw FROM telegram_messages WHERE id=?", (original_id,)).fetchone()
        self.assertEqual(original["body_raw"], "Original message")
        self.assertEqual(self.archive.summary(self.message["peer_id"])["versions"], 2)

    def test_probe_does_not_advance_watch_checkpoint(self):
        self.archive.save(self.message)
        self.assertIsNone(self.archive.last_message_id(self.message["peer_id"]))

    def test_watch_checkpoint_never_moves_back_and_survives_restart(self):
        self.archive.checkpoint(self.message["peer_id"], "Test channel", 42)
        self.archive.checkpoint(self.message["peer_id"], "Test channel", 40)
        self.archive.close()
        self.archive = Archive(self.directory.name)
        self.assertEqual(self.archive.last_message_id(self.message["peer_id"]), 42)

    def test_non_image_attachment_is_only_recorded_as_metadata(self):
        message = {**self.message, "attachments": [{"media_id": "999", "kind": "document",
                                                   "mime_type": "video/mp4", "size": 20000}]}
        row_id, _ = self.archive.save(message)
        self.assertEqual(self.archive.attachment_rows(row_id)[0]["status"], "metadata_only")

    @unittest.skipUnless(sys.platform == "win32", "Windows DPAPI requires Windows")
    def test_dpapi_roundtrip_never_writes_secret_in_plaintext(self):
        file = Path(self.directory.name) / "session.dpapi"
        secret = {"session": "test-only-session-secret"}
        write_secret(file, secret)
        self.assertNotIn(secret["session"].encode(), file.read_bytes())
        self.assertEqual(read_secret(file), secret)


if __name__ == "__main__":
    unittest.main()
