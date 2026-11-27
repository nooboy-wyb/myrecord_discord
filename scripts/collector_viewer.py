import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import time
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


SHANGHAI = timezone(timedelta(hours=8))
ASSETS = {"/": "index.html", "/index.html": "index.html",
          "/app.js": "app.js", "/live-data.js": "live-data.js",
          "/styles.css": "styles.css", "/assets/mark.svg": "assets/mark.svg"}


def now():
    return datetime.now(timezone.utc).isoformat()


def parsed(value):
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return stamp if stamp.tzinfo else None
    except (ValueError, TypeError):
        return None


def display(value):
    stamp = parsed(value)
    return stamp.astimezone(SHANGHAI).strftime("%m-%d %H:%M:%S") if stamp else None


def elapsed(start, end):
    first, last = parsed(start), parsed(end)
    return round((last - first).total_seconds(), 1) if first and last and last >= first else None


def decode(value, fallback=None):
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return {} if fallback is None else fallback


class ViewerStore:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.cached = None
        self.cached_at = 0

    @contextmanager
    def database(self, relative):
        connection = sqlite3.connect((self.root / relative).as_uri() + "?mode=ro", uri=True, timeout=0.05)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        deadline = time.monotonic() + 0.2
        connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        try:
            yield connection
        finally:
            connection.close()

    def image_path(self, value, source, day=None):
        if not value:
            return None
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = self.root / candidate
        candidate = candidate.resolve()
        allowed = self.root / ("telegram" if source == "telegram" else day) / "attachments"
        if not candidate.is_relative_to(allowed.resolve()):
            return None
        return candidate if candidate.is_file() else None

    def image(self, row, source, day=None):
        path = self.image_path(row.get("local_path"), source, day)
        identity = f"tg:{row['id']}" if source == "telegram" else f"dc:{day}:{row['id']}"
        saved = row.get("status") == "saved" and path is not None
        return {"id": identity, "name": path.name if path else "归档图片",
                "url": "/viewer/v1/attachments/" + identity if saved else None,
                "status": "saved" if saved else "failed" if row.get("status") == "saved" else row.get("status", "pending"),
                "size": f"{path.stat().st_size / 1024:.1f} KB · 存在，未重算哈希" if saved else "未就绪",
                "error": row.get("error") or ("登记为已保存，但允许目录内文件不存在" if row.get("status") == "saved" and not saved else None)}

    def base_message(self, source, row, identity, channel_id, message_id, captured):
        payload = decode(row.get("payload_json"))
        channel = row.get("channel_name") or channel_id
        if source == "telegram" and payload.get("topic_title"):
            channel += " · " + str(payload["topic_title"])
        return {"id": identity, "source": source, "channel": channel, "channelId": channel_id,
                "author": row.get("author_display") or "来源未记录作者",
                "messageId": str(message_id), "body": row.get("body_raw") or "",
                "sourceAt": row.get("source_timestamp"), "capturedAt": captured,
                "sourceTime": display(row.get("source_timestamp")), "capturedTime": display(captured),
                "captureSeconds": elapsed(row.get("source_timestamp"), captured),
                "contentHash": row.get("content_sha256"), "version": (row.get("content_sha256") or "")[:8],
                "images": [], "status": "archived", "group": "未关联发送任务",
                "attempts": 0, "origin": "归档", "parts": [], "deliveries": [],
                "reason": "当前窗口未关联发送任务；不代表消息应该转发或已经发送。"}

    def discord(self):
        messages = []
        today = datetime.now(SHANGHAI).date()
        for offset in (0, 1):
            day = str(today - timedelta(days=offset))
            relative = f"{day}/messages.sqlite"
            if not (self.root / relative).is_file():
                continue
            with self.database(relative) as connection:
                rows = connection.execute("SELECT * FROM discord_web_messages ORDER BY id DESC LIMIT 100").fetchall()
                for raw in rows:
                    row = dict(raw)
                    item = self.base_message("discord", row, f"dc:{day}:{row['id']}", row["channel_id"], row["source_message_id"], row["captured_at"])
                    files = {entry["source_url"]: dict(entry) for entry in connection.execute(
                        "SELECT * FROM discord_web_attachment_files WHERE message_id=? LIMIT 100", (row["id"],))}
                    for index, attachment in enumerate(decode(row["attachments_json"], [])):
                        url = attachment if isinstance(attachment, str) else attachment.get("url") or attachment.get("source_url")
                        file = files.get(url)
                        item["images"].append(self.image(file, "discord", day) if file else {
                            "id": f"missing:{item['id']}:{index}", "name": "未登记图片", "url": None,
                            "status": "pending", "error": "附件清单存在，但尚无下载记录", "size": "未就绪"})
                    messages.append(item)
        unique = {}
        for item in messages:
            key = (item["channelId"], item["messageId"], item["contentHash"])
            existing = unique.get(key)
            if existing:
                if item["capturedAt"] < existing["capturedAt"]:
                    existing["capturedAt"] = item["capturedAt"]
                    existing["capturedTime"] = item["capturedTime"]
                    existing["captureSeconds"] = item["captureSeconds"]
                continue
            unique[key] = item
        return sorted(unique.values(), key=lambda item: item["capturedAt"], reverse=True)[:100]

    def telegram(self):
        with self.database("telegram/archive.sqlite") as connection:
            messages = []
            for raw in connection.execute("SELECT * FROM telegram_messages ORDER BY id DESC LIMIT 100").fetchall():
                row = dict(raw)
                payload = decode(row["payload_json"])
                item = self.base_message("telegram", row, f"tg:{row['id']}",
                                         f"telegram:{row['peer_id']}:{payload.get('topic_id') or 'all'}",
                                         f"telegram:{row['peer_id']}:{row['message_id']}", row["first_observed_at"])
                item["images"] = [self.image(dict(entry), "telegram") for entry in connection.execute(
                    "SELECT * FROM telegram_attachments WHERE message_row_id=? AND kind='image' LIMIT 100", (row["id"],))]
                messages.append(item)
            return messages

    def group_names(self):
        groups = {}
        for relative in ("qq-additional-routes.json", "qq-group-openid.json"):
            try:
                value = json.loads((self.root / relative).read_text(encoding="utf-8-sig"))
                for route in value.get("routes", [value]):
                    if route.get("group_openid"):
                        groups[route["group_openid"]] = route.get("name") or "主群"
            except (OSError, ValueError):
                pass
        return groups

    def queue(self, messages):
        names = self.group_names()
        by_identity = {}
        for item in messages:
            by_identity.setdefault(item["messageId"], []).append(item)
        with self.database("qq-forward.sqlite") as connection:
            pending = connection.execute("SELECT * FROM sender_outbox WHERE status IN ('queued','deferred') ORDER BY next_attempt_at,source_timestamp LIMIT 100").fetchall()
            recent = connection.execute("SELECT * FROM sender_outbox ORDER BY rowid DESC LIMIT 100").fetchall()
            tasks = {row["task_key"]: dict(row) for row in [*recent, *pending]}
            part_rows = [dict(row) for row in connection.execute("SELECT * FROM forward_attempts ORDER BY rowid DESC LIMIT 300")]
            part_map = {}
            for row in part_rows:
                part_map.setdefault(row["task_key"], []).append(row)
            for key in tasks:
                part_map[key] = [dict(row) for row in connection.execute(
                    "SELECT * FROM forward_attempts WHERE task_key=? ORDER BY part_index LIMIT 100", (key,))]
            queue = []
            for key in dict.fromkeys([*tasks, *part_map]):
                job = tasks.get(key)
                parts = part_map.get(key, [])
                first = job or parts[0]
                snapshot = decode(job["message_json"]) if job else {}
                digest = snapshot.get("content_sha256")
                matches = by_identity.get(first["source_message_id"], [])
                match = next((item for item in matches if digest and item["contentHash"] == digest), None)
                if not job:
                    match = next((item for item in matches if hashlib.sha256(json.dumps([
                        first["group_openid"], item["channelId"], item["messageId"], item["contentHash"]],
                        separators=(",", ":"), ensure_ascii=False).encode()).hexdigest() == key), None)
                source = (job or {}).get("source") or ("telegram" if first["source_message_id"].startswith("telegram:") else "discord")
                item = dict(match) if match else self.base_message(source, {"source_timestamp": first.get("source_timestamp"), **snapshot}, "qq:" + key,
                        first.get("channel_id") or "未知频道", first["source_message_id"], snapshot.get("captured_at"))
                item.update({"id": "qq:" + key, "group": names.get(first["group_openid"], "目标群 · " + hashlib.sha256(first["group_openid"].encode()).hexdigest()[:8]),
                             "status": job["status"] if job else "recorded", "rawStatus": job["status"] if job else "仅分段记录",
                             "attempts": job["attempts"] if job else None, "taskKey": key,
                             "origin": "历史补发" if any(part.get("replay_request_id") for part in parts) else "常规任务" if job else "历史分段记录",
                             "qqBody": snapshot.get("body_raw") or item["body"] or "未保存当次发送正文，当前归档窗口也无对应版本。",
                             "parts": [{"index": part["part_index"], "type": part["part_type"], "status": part["status"],
                                        "time": display(part["attempted_at"]), "receipt": part["platform_message_id"],
                                        "error": part["error"], "httpStatus": part["http_status"]} for part in parts],
                             "reason": (job or {}).get("error") or "旧版未记录详细阻塞原因与完整重试历史。",
                             "updatedTime": display((job or {}).get("updated_at")),
                             "nextAttempt": display(datetime.fromtimestamp(job["next_attempt_at"] / 1000, timezone.utc).isoformat()) if job and job["next_attempt_at"] else None,
                             "enqueuedTime": None, "attemptTime": None, "acceptedTime": None})
                if job and job["status"] == "accepted" and parts and all(part["status"] == "accepted" for part in parts):
                    accepted = max(part["attempted_at"] for part in parts)
                    item["acceptedTime"] = display(accepted)
                    item["sendSeconds"] = elapsed(item.get("capturedAt"), accepted)
                    item["totalSeconds"] = elapsed(item.get("sourceAt"), accepted)
                queue.append(item)
            counts = [dict(row) for row in connection.execute("SELECT status,COUNT(*) AS count FROM sender_outbox GROUP BY status")]
            replays = [dict(row) for row in connection.execute(
                "SELECT id,status,created_at,completed_at FROM replay_requests ORDER BY id DESC LIMIT 20")]
        for item in messages:
            deliveries = [task for task in queue if task["messageId"] == item["messageId"] and task.get("contentHash") == item["contentHash"]]
            item["deliveries"] = [{"group": task["group"], "status": task["status"], "taskKey": task["taskKey"]} for task in deliveries]
        return queue, counts, replays

    def health(self):
        result = {}
        token_file = self.root / "collector-token.txt"
        for role, port in (("discord", 8765), ("qq", 8766)):
            try:
                token = token_file.read_text(encoding="utf-8-sig").strip()
                request = urllib.request.Request(f"http://127.0.0.1:{port}/v1/health", headers={"x-collector-token": token})
                with urllib.request.urlopen(request, timeout=0.6) as response:
                    raw = json.loads(response.read(1024 * 1024))
                keys = ("role", "at", "online", "running", "last_capture_at", "last_error", "lastError", "pages", "planners", "outbox")
                result[role] = {key: raw[key] for key in keys if key in raw}
                result[role]["reachable"] = True
            except (OSError, ValueError):
                result[role] = {"reachable": False, "error": "健康接口暂不可用"}
        try:
            raw = json.loads((self.root / "telegram/monitor-status.json").read_text(encoding="utf-8-sig"))
            result["telegram"] = {key: raw[key] for key in ("at", "phase", "round_finished_at", "sources") if key in raw}
            stamp = parsed(raw.get("at"))
            result["telegram"]["stale"] = not stamp or (datetime.now(timezone.utc) - stamp).total_seconds() > 90
        except (OSError, ValueError):
            result["telegram"] = {"stale": True, "error": "采集状态文件暂不可用"}
        return result

    def snapshot(self):
        if self.cached and time.monotonic() - self.cached_at < 4:
            return self.cached
        started = time.monotonic()
        previous = self.cached or {}
        result = {"messages": [], "queue": [], "errors": [], "sourceSamples": {}, "mode": "live", "sampledAt": now()}
        for source, reader in (("discord", self.discord), ("telegram", self.telegram)):
            try:
                result["messages"].extend(reader())
                result["sourceSamples"][source] = {"at": now(), "stale": False}
            except (OSError, sqlite3.Error, ValueError, KeyError, TypeError):
                result["messages"].extend(item for item in previous.get("messages", []) if item["source"] == source)
                result["sourceSamples"][source] = {**previous.get("sourceSamples", {}).get(source, {}), "stale": True}
                result["errors"].append(source + " 归档暂不可读，保留上次结果")
        result["messages"].sort(key=lambda item: item.get("capturedAt") or "", reverse=True)
        try:
            result["queue"], result["queueCounts"], result["replays"] = self.queue(result["messages"])
            result["sourceSamples"]["qq"] = {"at": now(), "stale": False}
        except (OSError, sqlite3.Error, ValueError, KeyError, TypeError):
            for key in ("queue", "queueCounts", "replays"):
                result[key] = previous.get(key, [])
            result["sourceSamples"]["qq"] = {**previous.get("sourceSamples", {}).get("qq", {}), "stale": True}
            result["errors"].append("QQ 状态暂不可读，保留上次结果")
        result["connections"] = self.health()
        result["queryMs"] = round((time.monotonic() - started) * 1000)
        self.cached, self.cached_at = result, time.monotonic()
        return result

    def attachment(self, identity):
        if re.fullmatch(r"tg:\d+", identity):
            source, day, table, relative = "telegram", None, "telegram_attachments", "telegram/archive.sqlite"
        elif re.fullmatch(r"dc:\d{4}-\d{2}-\d{2}:\d+", identity):
            source, day, table = "discord", identity.split(":")[1], "discord_web_attachment_files"
            relative = f"{day}/messages.sqlite"
        else:
            return None
        with self.database(relative) as connection:
            row = connection.execute(f"SELECT local_path,status FROM {table} WHERE id=?", (int(identity.split(":")[-1]),)).fetchone()
        return self.image_path(row["local_path"], source, day) if row and row["status"] == "saved" else None


class ViewerServer(HTTPServer):
    def __init__(self, address, store, assets, token, idle_timeout=120):
        self.store, self.assets, self.token = store, Path(assets), token
        self.last_activity, self.idle_timeout = time.monotonic(), idle_timeout
        super().__init__(address, ViewerHandler)
        self.timeout = 1


class ViewerHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, code, body=b"", mime="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_POST(self):
        self.reply(405)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not hmac.compare_digest(self.headers.get("x-viewer-token", "").encode(), self.server.token.encode()):
            self.reply(401)
            return
        self.server.last_activity = time.monotonic()
        name = unquote(urlsplit(self.path).path)
        try:
            if name == "/viewer/v1/ping":
                self.reply(200, b'{"ok":true}')
            elif name == "/viewer/v1/snapshot":
                self.reply(200, json.dumps(self.server.store.snapshot(), ensure_ascii=False).encode("utf-8"))
            elif name.startswith("/viewer/v1/attachments/"):
                path = self.server.store.attachment(name.rsplit("/", 1)[-1])
                if not path:
                    self.reply(404)
                    return
                mime = mimetypes.guess_type(str(path))[0]
                if mime not in ("image/png", "image/jpeg", "image/gif", "image/webp") or path.stat().st_size > 30 * 1024 * 1024:
                    self.reply(415)
                    return
                self.reply(200, path.read_bytes(), mime)
            elif name in ASSETS:
                path = self.server.assets / ASSETS[name]
                body = path.read_bytes()
                if path.name == "index.html":
                    body = body.replace(b'demo-data.js', b'live-data.js')
                mime = {".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml"}[path.suffix]
                self.reply(200, body, mime + "; charset=utf-8")
            else:
                self.reply(404)
        except (OSError, sqlite3.Error, ValueError):
            self.reply(503)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default=os.environ.get("MUSE_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--idle-timeout", type=int, default=120)
    args = parser.parse_args()
    root = Path(args.data_dir).resolve()
    folder = root / "viewer"
    folder.mkdir(parents=True, exist_ok=True)
    token_file = folder / "token.txt"
    if not token_file.exists():
        try:
            with token_file.open("x", encoding="ascii") as output:
                output.write(secrets.token_hex(32))
        except FileExistsError:
            pass
    token = token_file.read_text(encoding="ascii").strip()
    if len(token) < 32:
        raise ValueError("Invalid viewer credential")
    server = ViewerServer(("127.0.0.1", args.port), ViewerStore(root), Path(__file__).resolve().parent.parent / "viewer", token, args.idle_timeout)
    print(f"Read-only viewer on 127.0.0.1:{args.port}; idle exit {args.idle_timeout}s", flush=True)
    try:
        while time.monotonic() - server.last_activity < server.idle_timeout:
            server.handle_request()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
