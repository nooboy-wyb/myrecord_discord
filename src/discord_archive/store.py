import hashlib
import json
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo("Asia/Shanghai")


def database_path(root: Path, captured_at: datetime) -> Path:
    return root / captured_at.astimezone(SHANGHAI).strftime("%Y-%m-%d") / "messages.sqlite"


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS captures (
            id INTEGER PRIMARY KEY,
            captured_at TEXT NOT NULL,
            source_path TEXT NOT NULL,
            sha256 TEXT NOT NULL UNIQUE,
            channel_hint TEXT,
            ocr_model TEXT NOT NULL,
            ocr_elapsed_seconds REAL
        );
        CREATE TABLE IF NOT EXISTS ocr_lines (
            id INTEGER PRIMARY KEY,
            capture_id INTEGER NOT NULL REFERENCES captures(id),
            line_index INTEGER NOT NULL,
            text_raw TEXT NOT NULL,
            polygon_json TEXT NOT NULL,
            confidence REAL,
            UNIQUE(capture_id, line_index)
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY,
            capture_id INTEGER NOT NULL REFERENCES captures(id),
            channel TEXT NOT NULL,
            author_display TEXT NOT NULL,
            displayed_time TEXT,
            body_raw TEXT NOT NULL,
            grouping_method TEXT NOT NULL,
            review_status TEXT NOT NULL DEFAULT 'needs_review',
            created_at TEXT NOT NULL,
            UNIQUE(capture_id, channel, author_display, displayed_time, body_raw)
        );
        CREATE TABLE IF NOT EXISTS message_evidence (
            message_id INTEGER NOT NULL REFERENCES messages(id),
            ocr_line_id INTEGER NOT NULL REFERENCES ocr_lines(id),
            PRIMARY KEY(message_id, ocr_line_id)
        );
        CREATE TABLE IF NOT EXISTS attachments (
            id INTEGER PRIMARY KEY,
            message_id INTEGER NOT NULL REFERENCES messages(id),
            path TEXT NOT NULL,
            kind TEXT NOT NULL,
            sha256 TEXT
        );
        CREATE TABLE IF NOT EXISTS forward_attempts (
            id INTEGER PRIMARY KEY,
            message_id INTEGER NOT NULL REFERENCES messages(id),
            destination TEXT NOT NULL,
            attempted_at TEXT NOT NULL,
            status TEXT NOT NULL,
            payload TEXT NOT NULL,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_messages_channel_time ON messages(channel, displayed_time);
    """)
    return db


def ingest_capture(db: sqlite3.Connection, image: Path, captured_at: datetime, result, channel: str) -> tuple[int, bool]:
    digest = hashlib.sha256(image.read_bytes()).hexdigest()
    archive = Path(db.execute("PRAGMA database_list").fetchone()[2]).parent / "screenshots" / f"{digest}{image.suffix.lower()}"
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        shutil.copy2(image, archive)
    existing = db.execute("SELECT id FROM captures WHERE sha256=?", (digest,)).fetchone()
    if existing:
        with db:
            db.execute("UPDATE captures SET source_path=? WHERE id=?", (str(archive.resolve()), existing[0]))
        return existing[0], False
    with db:
        cur = db.execute(
            "INSERT INTO captures(captured_at,source_path,sha256,channel_hint,ocr_model,ocr_elapsed_seconds) VALUES(?,?,?,?,?,?)",
            (captured_at.isoformat(), str(archive.resolve()), digest, channel, "RapidOCR PP-OCRv6 small / ONNX CPU", result.elapse),
        )
        capture_id = cur.lastrowid
        boxes = result.boxes if result.boxes is not None else []
        scores = result.scores if result.scores is not None else []
        for i, (text, box, score) in enumerate(zip(result.txts or [], boxes, scores)):
            db.execute(
                "INSERT INTO ocr_lines(capture_id,line_index,text_raw,polygon_json,confidence) VALUES(?,?,?,?,?)",
                (capture_id, i, text, json.dumps(box.tolist(), ensure_ascii=False), float(score)),
            )
    return capture_id, True


def add_message(db: sqlite3.Connection, capture_id: int, channel: str, author: str, displayed_time: str,
                body: str, line_indexes: list[int], method: str = "manual_sample") -> int:
    now = datetime.now(SHANGHAI).isoformat()
    with db:
        db.execute(
            "INSERT OR IGNORE INTO messages(capture_id,channel,author_display,displayed_time,body_raw,grouping_method,created_at) VALUES(?,?,?,?,?,?,?)",
            (capture_id, channel, author, displayed_time, body, method, now),
        )
        message_id = db.execute(
            "SELECT id FROM messages WHERE capture_id=? AND channel=? AND author_display=? AND displayed_time=? AND body_raw=?",
            (capture_id, channel, author, displayed_time, body),
        ).fetchone()[0]
        for index in line_indexes:
            row = db.execute("SELECT id FROM ocr_lines WHERE capture_id=? AND line_index=?", (capture_id, index)).fetchone()
            if row:
                db.execute("INSERT OR IGNORE INTO message_evidence(message_id,ocr_line_id) VALUES(?,?)", (message_id, row[0]))
    return message_id


def format_forward(channel: str, author: str, displayed_time: str, body: str) -> str:
    return f"【Discord｜{channel}】{author} · {displayed_time}\n{body}"
