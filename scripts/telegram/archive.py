import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def content_digest(message):
    identity = [message["body_raw"], message.get("edit_timestamp"),
                message.get("grouped_id"), message.get("attachments", [])]
    return hashlib.sha256(json.dumps(identity, sort_keys=True,
                                    ensure_ascii=False).encode("utf-8")).hexdigest()


class Archive:
    def __init__(self, folder):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.folder / "archive.sqlite", timeout=15)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS telegram_messages (
                id INTEGER PRIMARY KEY,
                peer_id TEXT NOT NULL, message_id TEXT NOT NULL,
                channel_name TEXT NOT NULL, source_timestamp TEXT NOT NULL,
                edit_timestamp TEXT, grouped_id TEXT, body_raw TEXT NOT NULL,
                content_sha256 TEXT NOT NULL, payload_json TEXT NOT NULL,
                first_observed_at TEXT NOT NULL, last_observed_at TEXT NOT NULL,
                UNIQUE(peer_id, message_id, content_sha256)
            );
            CREATE INDEX IF NOT EXISTS ix_telegram_message_identity
                ON telegram_messages(peer_id,message_id);
            CREATE TABLE IF NOT EXISTS telegram_attachments (
                id INTEGER PRIMARY KEY, message_row_id INTEGER NOT NULL,
                media_id TEXT NOT NULL, kind TEXT NOT NULL, mime_type TEXT,
                expected_size INTEGER, status TEXT NOT NULL,
                local_path TEXT, sha256 TEXT, error TEXT,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(message_row_id) REFERENCES telegram_messages(id),
                UNIQUE(message_row_id,media_id)
            );
            CREATE TABLE IF NOT EXISTS telegram_channel_state (
                peer_id TEXT PRIMARY KEY, channel_name TEXT NOT NULL,
                last_message_id INTEGER NOT NULL, updated_at TEXT NOT NULL
            );
        """)

    def close(self):
        self.connection.close()

    def save(self, message):
        digest = content_digest(message)
        observed_at = utc_now()
        with self.connection:
            result = self.connection.execute("""
                INSERT OR IGNORE INTO telegram_messages
                (peer_id,message_id,channel_name,source_timestamp,edit_timestamp,
                 grouped_id,body_raw,content_sha256,payload_json,first_observed_at,last_observed_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """, (message["peer_id"], message["message_id"], message["channel_name"],
                  message["source_timestamp"], message.get("edit_timestamp"),
                  message.get("grouped_id"), message["body_raw"], digest,
                  json.dumps(message, ensure_ascii=False), observed_at, observed_at))
            inserted = result.rowcount == 1
            row = self.connection.execute("""
                SELECT id FROM telegram_messages
                WHERE peer_id=? AND message_id=? AND content_sha256=?
            """, (message["peer_id"], message["message_id"], digest)).fetchone()
            self.connection.execute("UPDATE telegram_messages SET last_observed_at=?,payload_json=? WHERE id=?",
                                    (observed_at, json.dumps(message, ensure_ascii=False), row["id"]))
            for attachment in message.get("attachments", []):
                status = "pending" if attachment["kind"] == "image" else "metadata_only"
                self.connection.execute("""
                    INSERT OR IGNORE INTO telegram_attachments
                    (message_row_id,media_id,kind,mime_type,expected_size,status,updated_at)
                    VALUES (?,?,?,?,?,?,?)
                """, (row["id"], attachment["media_id"], attachment["kind"],
                      attachment.get("mime_type"), attachment.get("size"), status, observed_at))
        return row["id"], inserted

    def checkpoint(self, peer_id, channel_name, message_id):
        with self.connection:
            self.connection.execute("""
                INSERT INTO telegram_channel_state(peer_id,channel_name,last_message_id,updated_at)
                VALUES (?,?,?,?) ON CONFLICT(peer_id) DO UPDATE SET
                channel_name=excluded.channel_name,
                last_message_id=MAX(last_message_id,excluded.last_message_id),
                updated_at=excluded.updated_at
            """, (peer_id, channel_name, int(message_id), utc_now()))

    def last_message_id(self, peer_id):
        row = self.connection.execute("SELECT last_message_id FROM telegram_channel_state WHERE peer_id=?",
                                      (peer_id,)).fetchone()
        return row["last_message_id"] if row else None

    def attachment_rows(self, message_row_id):
        return self.connection.execute("SELECT * FROM telegram_attachments WHERE message_row_id=? ORDER BY id",
                                       (message_row_id,)).fetchall()

    def attachment_result(self, attachment_id, status, local_path=None, digest=None, error=None):
        with self.connection:
            self.connection.execute("""
                UPDATE telegram_attachments SET status=?,local_path=?,sha256=?,error=?,updated_at=?
                WHERE id=?
            """, (status, str(local_path) if local_path else None, digest, error, utc_now(), attachment_id))

    def summary(self, peer_id):
        messages = self.connection.execute("""
            SELECT COUNT(*) AS versions,COUNT(DISTINCT message_id) AS messages
            FROM telegram_messages WHERE peer_id=?
        """, (peer_id,)).fetchone()
        attachments = self.connection.execute("""
            SELECT a.status,COUNT(*) AS count FROM telegram_attachments a
            JOIN telegram_messages m ON m.id=a.message_row_id WHERE m.peer_id=? GROUP BY a.status
        """, (peer_id,)).fetchall()
        return {**dict(messages), "attachments": {row["status"]: row["count"] for row in attachments}}
