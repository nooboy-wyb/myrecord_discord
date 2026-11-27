import http.client
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from collector_viewer import SHANGHAI, ViewerServer, ViewerStore


class ViewerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.day = str(datetime.now(SHANGHAI).date())
        self.store = ViewerStore(self.root)
        self.store.health = lambda: {}
        (self.root / self.day / "attachments").mkdir(parents=True)
        (self.root / "telegram" / "attachments").mkdir(parents=True)
        self.picture = self.root / self.day / "attachments" / "sample.png"
        self.picture.write_bytes(b"test-image")
        self.dc = sqlite3.connect(self.root / self.day / "messages.sqlite")
        self.dc.executescript("""
            CREATE TABLE discord_web_messages(id INTEGER PRIMARY KEY, channel_id TEXT, source_message_id TEXT,
                channel_name TEXT,author_display TEXT,source_timestamp TEXT,captured_at TEXT,body_raw TEXT,
                attachments_json TEXT,payload_json TEXT,content_sha256 TEXT);
            CREATE TABLE discord_web_attachment_files(id INTEGER PRIMARY KEY,message_id INTEGER,source_url TEXT,
                local_path TEXT,status TEXT,error TEXT);
        """)
        self.dc.execute("INSERT INTO discord_web_messages VALUES(1,'chan','42','channel','author',?,?,?,?,?,?)",
                        ("2026-11-27T01:00:00Z", "2026-11-27T01:00:13Z", "<script>untrusted</script>",
                         '[{"source_url":"https://example.test/image"}]', "{}", "version-a"))
        self.dc.execute("INSERT INTO discord_web_attachment_files VALUES(1,1,?,?,?,NULL)",
                        ("https://example.test/image", str(self.picture), "saved"))
        self.dc.commit()
        self.tg = sqlite3.connect(self.root / "telegram" / "archive.sqlite")
        self.tg.executescript("""
            CREATE TABLE telegram_messages(id INTEGER PRIMARY KEY,peer_id TEXT,message_id TEXT,channel_name TEXT,
                source_timestamp TEXT,first_observed_at TEXT,body_raw TEXT,payload_json TEXT,content_sha256 TEXT);
            CREATE TABLE telegram_attachments(id INTEGER PRIMARY KEY,message_row_id INTEGER,kind TEXT,
                local_path TEXT,status TEXT,error TEXT);
        """)
        self.tg.execute("INSERT INTO telegram_messages VALUES(1,'-100','9','TG',?,?,?,?,?)",
                        ("2026-11-27T01:00:00Z", "2026-11-27T01:00:13Z", "actual TG", "{}", "tg-a"))
        self.tg.commit()
        self.qq = sqlite3.connect(self.root / "qq-forward.sqlite")
        self.qq.executescript("""
            CREATE TABLE sender_outbox(task_key TEXT PRIMARY KEY,source TEXT,group_openid TEXT,channel_id TEXT,
                source_message_id TEXT,source_timestamp TEXT,message_json TEXT,context_json TEXT,status TEXT,
                next_attempt_at INTEGER,attempts INTEGER,updated_at TEXT,error TEXT);
            CREATE TABLE forward_attempts(task_key TEXT,part_index INTEGER,part_type TEXT,source_message_id TEXT,
                group_openid TEXT,status TEXT,attempted_at TEXT,http_status INTEGER,platform_message_id TEXT,
                error TEXT,channel_id TEXT,replay_request_id INTEGER);
            CREATE TABLE replay_requests(id INTEGER PRIMARY KEY,status TEXT,created_at TEXT,completed_at TEXT);
        """)
        for key, group, status in (("task-a", "group-a", "accepted"), ("task-b", "group-b", "unknown")):
            self.qq.execute("INSERT INTO sender_outbox VALUES(?,?,?,?,?,?,?,?,?,0,1,?,NULL)",
                            (key, "discord", group, "chan", "42", "2026-11-27T01:00:00Z",
                             json.dumps({"content_sha256": "version-a", "body_raw": "snapshot"}), "{}", status,
                             "2026-11-27T01:02:14Z"))
            self.qq.execute("INSERT INTO forward_attempts VALUES(?,0,'text','42',?,?,?,200,'receipt',NULL,'chan',NULL)",
                            (key, group, status, "2026-11-27T01:02:14Z"))
        self.qq.commit()

    def tearDown(self):
        for connection in (self.dc, self.tg, self.qq):
            connection.close()
        self.temporary.cleanup()

    def test_version_and_group_association_preserves_unknown(self):
        result = self.store.snapshot()
        self.assertEqual(result["errors"], [])
        message = next(item for item in result["messages"] if item["source"] == "discord")
        self.assertEqual(len(message["deliveries"]), 2)
        self.assertEqual(message["status"], "archived")
        accepted = next(item for item in result["queue"] if item["status"] == "accepted")
        unknown = next(item for item in result["queue"] if item["status"] == "unknown")
        self.assertEqual((accepted["totalSeconds"], accepted["sendSeconds"]), (134, 121))
        self.assertIsNone(unknown["acceptedTime"])
        self.assertIsNone(accepted["enqueuedTime"])
        self.assertEqual(message["images"][0]["status"], "saved")

    def test_only_matching_version_gets_linked(self):
        self.qq.execute("UPDATE sender_outbox SET message_json=?", ('{"content_sha256":"older-version"}',))
        self.qq.commit()
        result = self.store.snapshot()
        message = next(item for item in result["messages"] if item["source"] == "discord")
        self.assertEqual(message["deliveries"], [])

    def test_refresh_observes_attachment_change_and_retains_failed_source(self):
        first = self.store.snapshot()
        self.picture.unlink()
        self.store.cached_at = 0
        second = self.store.snapshot()
        message = next(item for item in second["messages"] if item["source"] == "discord")
        self.assertEqual(message["images"][0]["status"], "failed")
        self.dc.execute("DROP TABLE discord_web_messages")
        self.dc.commit()
        self.store.cached_at = 0
        third = self.store.snapshot()
        self.assertTrue(third["sourceSamples"]["discord"]["stale"])
        self.assertEqual(third["messages"], second["messages"])
        self.assertEqual(len(first["messages"]), 2)

    def test_connection_cannot_write_or_create_database(self):
        with self.store.database(f"{self.day}/messages.sqlite") as connection:
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("DELETE FROM discord_web_messages")
        with self.assertRaises(sqlite3.OperationalError):
            with self.store.database("absent.sqlite"):
                pass
        self.assertFalse((self.root / "absent.sqlite").exists())

    def test_attachment_id_cannot_escape_allowed_directory(self):
        self.assertEqual(self.store.attachment(f"dc:{self.day}:1"), self.picture.resolve())
        outside = self.root / "collector-token.txt"
        outside.write_text("secret")
        self.dc.execute("UPDATE discord_web_attachment_files SET local_path=?", (str(outside),))
        self.dc.commit()
        self.assertIsNone(self.store.attachment(f"dc:{self.day}:1"))
        self.assertIsNone(self.store.attachment("../../collector-token.txt"))

    def test_http_requires_credential_and_blocks_private_assets(self):
        assets = Path(__file__).resolve().parents[1] / "viewer"
        server = ViewerServer(("127.0.0.1", 0), self.store, assets, "private-token")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection(*server.server_address)
        try:
            connection.request("GET", "/viewer/v1/snapshot")
            response = connection.getresponse()
            self.assertEqual(response.status, 401)
            response.read()
            for name in ("/data/collector-token.txt", "/../data/collector-token.txt", "/demo-data.js"):
                connection.request("GET", name, headers={"x-viewer-token": "private-token"})
                response = connection.getresponse()
                self.assertEqual(response.status, 404)
                response.read()
            connection.request("GET", "/", headers={"x-viewer-token": "private-token"})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertIn(b'live-data.js', response.read())
            connection.request("GET", "/live-data.js", headers={"x-viewer-token": "private-token"})
            response = connection.getresponse()
            self.assertEqual(response.getheader("Content-Type"), "text/javascript; charset=utf-8")
            response.read()
            connection.request("POST", "/viewer/v1/snapshot")
            response = connection.getresponse()
            self.assertEqual(response.status, 405)
            response.read()
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
