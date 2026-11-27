import asyncio
import contextlib
import json
import os
import re
import socket
import time
import uuid
from datetime import datetime, timedelta, timezone

from archive import Archive, utc_now
from history import parse_until, verify_message, write_json_atomic

REQUEST_TIMEOUT = 30
SAVE_TIMEOUT = 90
DISCONNECT_TIMEOUT = 10
NETWORK_ERRNOS = {10050, 10051, 10052, 10053, 10054, 10060, 10061, 10064, 10065, 101, 104, 110, 111, 113}


def connection_failure(failure):
    if isinstance(failure, (ConnectionError, TimeoutError, socket.gaierror, socket.herror)):
        return True
    if isinstance(failure, OSError):
        return failure.errno in NETWORK_ERRNOS or getattr(failure, "winerror", None) in NETWORK_ERRNOS
    return type(failure).__name__ in {"ServerError", "TimedOutError", "RpcCallFailError", "ReadCancelledError"}


async def disconnect(client):
    if hasattr(client, "disconnect"):
        await asyncio.wait_for(client.disconnect(), timeout=DISCONNECT_TIMEOUT)


def failure_detail(failure):
    message = re.sub(r"(?:https?|socks\d?)://\S+", "[url]", str(failure))
    message = re.sub(r"(?i)(token|secret|password|api_hash|auth_key)([\s:=]+)\S+", r"\1\2[redacted]", message)
    return {"error": type(failure).__name__, "error_message": message[:500], "error_at": utc_now()}


def read_sources(file):
    configuration = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(configuration.get("sources"), list):
        raise ValueError("Invalid Telegram sources configuration")
    sources = [source for source in configuration["sources"] if source.get("enabled") is True]
    keys = set()
    for source in sources:
        topic = source.get("topic_id")
        key = (source.get("peer_id"), topic)
        if (not re.fullmatch(r"-\d+", source.get("peer_id", ""))
                or not source.get("target") or not source.get("enabled_at")
                or (topic is not None and (type(topic) is not int or topic < 1 or not source.get("topic_title")))
                or key in keys):
            raise ValueError("Invalid or duplicate Telegram source")
        parse_until(source["enabled_at"])
        keys.add(key)
    if any((source["peer_id"], None) in keys for source in sources if source.get("topic_id") is not None):
        raise ValueError("Whole-peer and topic subscriptions overlap")
    return sources


@contextlib.contextmanager
def monitor_lock(folder):
    file = (folder / "monitor.lock").open("a+b")
    try:
        file.seek(0, os.SEEK_END)
        if file.tell() == 0:
            file.write(b"0")
            file.flush()
        file.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        file.close()


async def validate_topic(client, entity, source):
    if source.get("topic_id") is None:
        return
    if not getattr(entity, "forum", False):
        raise ValueError("Selected peer is not a forum")
    from telethon import functions

    response = await client(functions.messages.GetForumTopicsByIDRequest(peer=entity, topics=[source["topic_id"]]))
    if not any(item.id == source["topic_id"] and getattr(item, "title", None) == source["topic_title"]
               for item in response.topics):
        raise ValueError("Configured topic is unavailable or was renamed")


async def monitor_round(client, folder, sources, save_message, normalize, resolve_channel,
                        topic_validator=validate_topic, until=None):
    until = until or datetime.now(timezone.utc)
    status = {"role": "telegram-collector", "at": utc_now(), "phase": "scanning",
              "round_started_at": utc_now(), "sources": [], "qq_forwarding": False}
    archive = Archive(folder)
    archive.connection.execute("""CREATE TABLE IF NOT EXISTS telegram_monitor_state (
        source_key TEXT PRIMARY KEY, scan_until TEXT NOT NULL, updated_at TEXT NOT NULL)""")
    try:
        for source in sources:
            key = f"{source['peer_id']}:{source.get('topic_id') or 'all'}:{source['enabled_at']}"
            detail = {"peer_id": source["peer_id"], "topic_id": source.get("topic_id"), "read": 0,
                      "inserted": 0, "verified": 0, "scan_complete_to_boundary": False}
            detail.update(status="scanning", started_at=utc_now(), last_progress_at=utc_now())
            status["sources"].append(detail)
            status["at"] = utc_now()
            write_json_atomic(folder / "monitor-status.json", status)
            last_progress = time.monotonic()
            try:
                enabled = parse_until(source["enabled_at"])
                cursor = archive.connection.execute("SELECT scan_until FROM telegram_monitor_state WHERE source_key=?", (key,)).fetchone()
                since = max(enabled, parse_until(cursor["scan_until"])-timedelta(minutes=2)) if cursor else enabled
                detail.update(since=since.isoformat(), until=until.isoformat())
                entity = await asyncio.wait_for(resolve_channel(client, source["peer_id"]), REQUEST_TIMEOUT)
                await asyncio.wait_for(topic_validator(client, entity, source), REQUEST_TIMEOUT)
                options = {"limit": None, "offset_date": until}
                if source.get("topic_id") is not None:
                    options["reply_to"] = source["topic_id"]
                iterator = client.iter_messages(entity, **options).__aiter__()
                while True:
                    try:
                        message = await asyncio.wait_for(iterator.__anext__(), REQUEST_TIMEOUT)
                    except StopAsyncIteration:
                        break
                    if message.date is None:
                        raise ValueError("Undated source message")
                    if message.date < since:
                        break
                    if message.date >= until:
                        continue
                    expected = normalize(entity, message)
                    if source.get("topic_id") is not None and expected.get("topic_id") != str(source["topic_id"]):
                        raise ValueError("Message belongs to another topic")
                    detail["inserted"] += await asyncio.wait_for(
                        save_message(client, archive, entity, message), SAVE_TIMEOUT)
                    detail["read"] += 1
                    if verify_message(archive, expected)[2]:
                        raise RuntimeError("Archive or image verification failed; checkpoint retained")
                    detail["verified"] += 1
                    if time.monotonic() - last_progress >= 10:
                        status["at"] = utc_now()
                        detail["last_progress_at"] = status["at"]
                        write_json_atomic(folder / "monitor-status.json", status)
                        last_progress = time.monotonic()
                with archive.connection:
                    archive.connection.execute("""INSERT INTO telegram_monitor_state VALUES (?,?,?)
                        ON CONFLICT(source_key) DO UPDATE SET scan_until=excluded.scan_until,updated_at=excluded.updated_at""",
                                               (key, until.isoformat(), utc_now()))
                detail.update(status="ok", scan_until=until.isoformat(), scan_complete_to_boundary=True)
            except Exception as failure:
                detail.update(status="error", **failure_detail(failure))
                if connection_failure(failure):
                    status.update(reconnect_required=True, **failure_detail(failure))
            detail["finished_at"] = utc_now()
            status["at"] = utc_now()
            write_json_atomic(folder / "monitor-status.json", status)
            if status.get("reconnect_required"):
                break
    finally:
        archive.close()
    status["at"] = utc_now()
    status.update(phase="idle", round_finished_at=status["at"])
    write_json_atomic(folder / "monitor-status.json", status)
    return status


async def monitor(client, folder, args, save_message, normalize, resolve_channel, client_factory=None):
    file = args.config or folder / "sources.json"
    deadline = time.monotonic()+args.seconds if args.seconds else None
    recovery_file = folder / "connection-recovery.json"
    recovery = json.loads(recovery_file.read_text(encoding="utf-8")) if recovery_file.exists() else None
    failures = 0
    with monitor_lock(folder):
        try:
            while deadline is None or time.monotonic() < deadline:
                reconnect = False
                try:
                    sources = read_sources(file)
                    if not client.is_connected():
                        await asyncio.wait_for(client.connect(), timeout=25)
                    if not await asyncio.wait_for(client.is_user_authorized(), REQUEST_TIMEOUT):
                        raise PermissionError("Telegram session is unauthorized")
                    status = await monitor_round(client, folder, sources, save_message, normalize, resolve_channel)
                    reconnect = status.get("reconnect_required", False)
                except Exception as failure:
                    status = {"role": "telegram-collector", "at": utc_now(), **failure_detail(failure)}
                    reconnect = connection_failure(failure)
                if reconnect:
                    failures += 1
                    if not recovery or recovery["state"] == "recovered":
                        recovery = {"id": "telegram-" + str(uuid.uuid4()), "state": "retrying",
                                    "started_at": utc_now(), "attempts": 0}
                    recovery.update(state="retrying", attempts=recovery["attempts"]+1,
                                    error=status.get("error", "ConnectionError"), last_failure_at=utc_now())
                    write_json_atomic(recovery_file, recovery)
                elif (not status.get("error") and all(item["status"] == "ok" for item in status.get("sources", []))):
                    failures = 0
                    if recovery and recovery["state"] != "recovered":
                        recovery.update(state="recovered", recovered_at=utc_now())
                        write_json_atomic(recovery_file, recovery)
                write_json_atomic(folder / "monitor-status.json", status)
                print(json.dumps(status, ensure_ascii=False), flush=True)
                if reconnect:
                    # A disconnect that cannot finish exits this worker; the supervisor owns process recovery.
                    await disconnect(client)
                    if client_factory:
                        client = client_factory()
                if deadline is not None and time.monotonic() >= deadline:
                    break
                delay = min(60, 10 * 2 ** min(max(0, failures-1), 3))
                await asyncio.sleep(min(delay, max(0, deadline-time.monotonic())) if deadline else delay)
        finally:
            await disconnect(client)
