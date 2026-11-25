import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from archive import Archive, content_digest, utc_now


def parse_until(value):
    if not value:
        return datetime.now(timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("History end time must include a timezone")
    return parsed.astimezone(timezone.utc)


def write_json_atomic(path, value):
    temporary = path.with_suffix(".tmp.json")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def verify_message(archive, expected):
    row = archive.connection.execute("""
        SELECT * FROM telegram_messages
        WHERE peer_id=? AND message_id=? AND content_sha256=?
    """, (expected["peer_id"], expected["message_id"], content_digest(expected))).fetchone()
    if row is None:
        return None, [], ["message_missing"]
    errors = []
    payload = json.loads(row["payload_json"])
    for field in ("body_raw", "source_timestamp", "edit_timestamp", "grouped_id"):
        if row[field] != expected.get(field):
            errors.append(f"message_{field}_mismatch")
    if payload.get("topic_id") != expected.get("topic_id"):
        errors.append("topic_mismatch")
    if content_digest(payload) != content_digest(expected):
        errors.append("payload_mismatch")
    attachments = [dict(item) for item in archive.attachment_rows(row["id"])]
    by_media = {item["media_id"]: item for item in attachments}
    for expected_attachment in expected["attachments"]:
        attachment = by_media.get(expected_attachment["media_id"])
        if attachment is None:
            errors.append("attachment_missing")
            continue
        if attachment["kind"] != "image":
            continue
        if attachment["status"] != "saved" or not attachment["local_path"]:
            errors.append(f"image_{attachment['status']}")
            continue
        try:
            with Path(attachment["local_path"]).open("rb") as file:
                digest = hashlib.file_digest(file, "sha256").hexdigest()
            if digest != attachment["sha256"]:
                errors.append("image_hash_mismatch")
        except OSError:
            errors.append("image_file_missing")
    return row["id"], attachments, errors


async def history(client, folder, args, save_message, entity, normalize):
    until = parse_until(args.until)
    since = until - timedelta(hours=args.hours)
    if args.topic is not None and not getattr(entity, "forum", False):
        raise ValueError("Selected peer is not a forum")
    directory = folder / "audits"
    directory.mkdir(parents=True, exist_ok=True)
    key = f"{args.channel.lstrip('-')}-{args.topic or 'all'}"
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid4().hex[:8]
    audit_file = directory / f"history-{key}-{run_id}.json"
    latest_file = directory / f"history-{key}-latest.json"
    success_file = directory / f"history-{key}-latest-success.json"
    previous = json.loads(success_file.read_text(encoding="utf-8")) if success_file.is_file() else None
    audit = {"action": "history", "run_id": run_id, "status": "running", "peer_id": args.channel,
             "channel_name": entity.title, "topic_id": args.topic, "topic_title": None,
             "since": since.isoformat(), "until": until.isoformat(), "started_at": utc_now(),
             "scan_complete_to_boundary": False, "boundary": None, "read": 0, "inserted": 0,
             "verified": 0, "errors": [], "messages": [], "qq_forwarding": False,
             "audit_file": str(audit_file)}
    write_json_atomic(audit_file, audit)
    archive = None
    try:
        archive = Archive(folder)
        if args.topic is not None:
            from telethon import functions

            response = await client(functions.messages.GetForumTopicsByIDRequest(peer=entity, topics=[args.topic]))
            topic = next((item for item in response.topics if item.id == args.topic and hasattr(item, "title")), None)
            if topic is None:
                raise ValueError("Selected topic is unavailable")
            audit["topic_title"] = topic.title
        options = {"limit": None, "offset_date": until}
        if args.topic is not None:
            options["reply_to"] = args.topic
        async for message in client.iter_messages(entity, **options):
            if not message.date:
                raise ValueError("API returned an undated message")
            message_time = message.date.astimezone(timezone.utc)
            if message_time < since:
                audit["boundary"] = {"reason": "older_message", "message_id": str(message.id),
                                     "timestamp": message_time.isoformat()}
                break
            if message_time >= until:
                continue
            expected = normalize(entity, message)
            if args.topic is not None and expected.get("topic_id") != str(args.topic):
                raise ValueError("API returned a message from another forum topic")
            audit["read"] += 1
            audit["inserted"] += await save_message(client, archive, entity, message)
            row_id, attachments, errors = verify_message(archive, expected)
            audit["messages"].append({**expected, "row_id": row_id, "content_sha256": content_digest(expected),
                                      "archived_attachments": attachments, "verification_errors": errors})
            audit["errors"].extend({"message_id": str(message.id), "error": error} for error in errors)
            audit["verified"] += not errors
            if audit["read"] % 250 == 0:
                write_json_atomic(audit_file, audit)
        if audit["boundary"] is None:
            audit["boundary"] = {"reason": "api_exhausted"}
        audit["scan_complete_to_boundary"] = True
        audit["messages"].sort(key=lambda item: int(item["message_id"]))
        fingerprint_input = [[item["message_id"], item["content_sha256"]] for item in audit["messages"]]
        audit["content_fingerprint"] = hashlib.sha256(json.dumps(fingerprint_input).encode("utf-8")).hexdigest()
        same_window = bool(previous and previous.get("since") == audit["since"] and previous.get("until") == audit["until"])
        audit["previous_same_window"] = same_window
        audit["previous_successful_run_id"] = previous.get("run_id") if previous else None
        audit["same_as_previous_scan"] = (previous.get("content_fingerprint") == audit["content_fingerprint"]) if same_window else None
        if same_window:
            old = {item["message_id"]: item["content_sha256"] for item in previous["messages"]}
            new = dict(fingerprint_input)
            audit["source_changes"] = {"added": sorted(new.keys() - old.keys()),
                                       "no_longer_returned": sorted(old.keys() - new.keys()),
                                       "changed": sorted(key for key in new.keys() & old.keys() if old[key] != new[key])}
        audit["status"] = "passed" if not audit["errors"] else "verification_failed"
        audit["summary"] = archive.summary(args.channel)
    except BaseException as failure:
        audit["status"] = "failed"
        audit["errors"].append({"error": type(failure).__name__})
        raise
    finally:
        if archive is not None:
            archive.close()
        audit["finished_at"] = utc_now()
        write_json_atomic(audit_file, audit)
        write_json_atomic(latest_file, audit)
        if audit["status"] == "passed":
            write_json_atomic(success_file, audit)
    print(json.dumps({key: value for key, value in audit.items() if key != "messages"}, ensure_ascii=False), flush=True)
    if audit["status"] != "passed":
        raise RuntimeError("History archive verification failed; inspect the saved audit")
    return audit
