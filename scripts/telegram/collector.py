import argparse
import asyncio
import getpass
import hashlib
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from archive import Archive
from secure_store import read_secret, write_secret


def report(**value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def proxy_settings():
    address = os.environ.get("TELEGRAM_PROXY", "").strip()
    if not address:
        return None
    proxy = urlsplit(address)
    if proxy.scheme not in {"http", "socks5", "socks4"} or not proxy.hostname or not proxy.port:
        raise ValueError("TELEGRAM_PROXY must be an HTTP or SOCKS proxy URL")
    return {"proxy_type": proxy.scheme, "addr": proxy.hostname, "port": proxy.port,
            "rdns": True, "username": proxy.username, "password": proxy.password}


def create_client(folder):
    from telethon import TelegramClient
    from telethon.sessions import StringSession

    credentials = read_secret(folder / "api.dpapi")
    session_file = folder / "session.dpapi"
    session = read_secret(session_file)["session"] if session_file.exists() else ""
    return TelegramClient(StringSession(session), int(credentials["api_id"]), credentials["api_hash"],
                          proxy=proxy_settings(), connection_retries=1, request_retries=1,
                          timeout=10, flood_sleep_threshold=0, device_model="Muse Telegram collector")


def configure(folder):
    if sys.stdin.isatty():
        configuration = {"api_id": int(input("API ID: ")),
                         "api_hash": getpass.getpass("API hash (hidden): ")}
    else:
        configuration = json.load(sys.stdin)
    if int(configuration["api_id"]) <= 0 or not re.fullmatch(r"[a-fA-F0-9]{32}", configuration["api_hash"]):
        raise ValueError("Invalid Telegram API configuration")
    write_secret(folder / "api.dpapi", configuration)
    report(configured=True, encryption="Windows DPAPI CurrentUser")


async def login(client, folder, method):
    if await client.is_user_authorized():
        report(authorized=True, existing_session=True)
        return
    from telethon.errors import SessionPasswordNeededError

    qr_file = folder / "login-qr.png"
    try:
        if method == "phone":
            phone = getpass.getpass("Telegram phone number with country code (hidden): ")
            await client.send_code_request(phone)
            try:
                await client.sign_in(phone, getpass.getpass("Telegram login code (hidden): "))
            except SessionPasswordNeededError:
                await client.sign_in(password=getpass.getpass("Two-step verification password (hidden): "))
        else:
            import qrcode

            for attempt in range(10):
                qr = await client.qr_login()
                image = qrcode.make(qr.url)
                temporary = qr_file.with_suffix(".tmp.png")
                image.save(temporary)
                temporary.replace(qr_file)
                report(login="scan_qr", qr_file=str(qr_file), expires_at=qr.expires.isoformat(),
                       attempt=attempt + 1)
                try:
                    await qr.wait(timeout=35)
                    break
                except asyncio.TimeoutError:
                    continue
                except SessionPasswordNeededError:
                    if not sys.stdin.isatty():
                        report(login="two_step_password_required", next_action="Run Login with -Interactive on the target")
                        return
                    await client.sign_in(password=getpass.getpass("Two-step verification password (hidden): "))
                    break
        if not await client.is_user_authorized():
            raise RuntimeError("Telegram login did not complete")
        write_secret(folder / "session.dpapi", {"session": client.session.save()})
        report(authorized=True, session_saved=True, encryption="Windows DPAPI CurrentUser")
    finally:
        qr_file.unlink(missing_ok=True)


def timestamp(value):
    return value.astimezone(timezone.utc).isoformat() if value else None


def normalize(entity, message):
    from telethon import utils

    attachments = []
    if message.photo:
        attachments.append({"media_id": str(message.photo.id), "kind": "image",
                            "mime_type": "image/jpeg", "size": None})
    elif message.document:
        document = message.document
        mime_type = document.mime_type or "application/octet-stream"
        kind = "image" if mime_type.startswith("image/") and not message.sticker else "document"
        attachments.append({"media_id": str(document.id), "kind": kind,
                            "mime_type": mime_type, "size": document.size})
    reply = getattr(message, "reply_to", None)
    topic_id = None
    if reply and getattr(reply, "forum_topic", False):
        topic_id = getattr(reply, "reply_to_top_id", None) or getattr(reply, "reply_to_msg_id", None)
    return {"source": "telegram", "peer_id": str(utils.get_peer_id(entity)),
            "channel_name": entity.title, "message_id": str(message.id),
            "source_timestamp": timestamp(message.date), "edit_timestamp": timestamp(message.edit_date),
            "grouped_id": str(message.grouped_id) if message.grouped_id else None,
            "topic_id": str(topic_id) if topic_id else None,
            "reply_to_message_id": str(reply.reply_to_msg_id) if reply and reply.reply_to_msg_id else None,
            "post_author": getattr(message, "post_author", None),
            "body_raw": message.raw_text or "", "attachments": attachments}


async def save_message(client, archive, entity, message):
    record = normalize(entity, message)
    row_id, inserted = archive.save(record)
    for attachment in archive.attachment_rows(row_id):
        if attachment["kind"] != "image":
            continue
        if attachment["status"] == "saved" and attachment["local_path"]:
            try:
                with Path(attachment["local_path"]).open("rb") as saved_file:
                    if hashlib.file_digest(saved_file, "sha256").hexdigest() == attachment["sha256"]:
                        continue
            except OSError:
                pass
        if attachment["expected_size"] and attachment["expected_size"] > 25_000_000:
            archive.attachment_result(attachment["id"], "skipped_size", error="Image exceeds 25 MB capture limit")
            continue
        directory = archive.folder / "attachments" / datetime.now(timezone.utc).strftime("%Y-%m-%d")
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / f"pending-{row_id}-{attachment['id']}.part"
        try:
            downloaded = await asyncio.wait_for(client.download_media(message, file=str(temporary)), timeout=60)
            if not downloaded:
                raise RuntimeError("Image download returned no file")
            downloaded = Path(downloaded)
            with downloaded.open("rb") as image_file:
                digest = hashlib.file_digest(image_file, "sha256").hexdigest()
            suffix = ".jpg" if attachment["mime_type"] == "image/jpeg" else ".png" if attachment["mime_type"] == "image/png" else ".image"
            saved = directory / f"{digest}{suffix}"
            downloaded.replace(saved)
            archive.attachment_result(attachment["id"], "saved", saved, digest)
        except Exception as failure:
            archive.attachment_result(attachment["id"], "failed", error=type(failure).__name__)
        finally:
            temporary.unlink(missing_ok=True)
    return inserted


async def resolve_channel(client, peer_id):
    from telethon import utils

    async for dialog in client.iter_dialogs(limit=1000):
        if dialog.is_channel and str(utils.get_peer_id(dialog.entity)) == peer_id:
            return dialog.entity
    raise ValueError("Selected channel is not in this account's available channel list")


async def probe(client, folder, args):
    entity = await resolve_channel(client, args.channel)
    archive = Archive(folder)
    try:
        messages = await client.get_messages(entity, limit=args.limit)
        inserted = 0
        for message in reversed(messages):
            inserted += await save_message(client, archive, entity, message)
        report(action="probe", peer_id=args.channel, read=len(messages), inserted=inserted,
               summary=archive.summary(args.channel), qq_forwarding=False)
    finally:
        archive.close()


async def watch(client, folder, args):
    entity = await resolve_channel(client, args.channel)
    archive = Archive(folder)
    deadline = time.monotonic() + args.seconds if args.seconds else None
    try:
        if archive.last_message_id(args.channel) is None:
            latest = await client.get_messages(entity, limit=1)
            if latest:
                await save_message(client, archive, entity, latest[0])
                archive.checkpoint(args.channel, entity.title, latest[0].id)
            else:
                archive.checkpoint(args.channel, entity.title, 0)
        report(action="watch", peer_id=args.channel, interval_seconds=10, qq_forwarding=False)
        while deadline is None or time.monotonic() < deadline:
            minimum = archive.last_message_id(args.channel)
            async for message in client.iter_messages(entity, min_id=minimum, reverse=True, limit=200):
                inserted = await save_message(client, archive, entity, message)
                archive.checkpoint(args.channel, entity.title, message.id)
                report(event="message_archived", peer_id=args.channel, message_id=str(message.id), inserted=inserted)
            for message in reversed(await client.get_messages(entity, limit=20)):
                await save_message(client, archive, entity, message)
            if deadline is not None and time.monotonic() >= deadline:
                break
            await asyncio.sleep(min(10, max(0, deadline - time.monotonic())) if deadline else 10)
        report(action="watch_complete", peer_id=args.channel, summary=archive.summary(args.channel))
    finally:
        archive.close()


async def run(args):
    folder = args.data_dir.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    if args.action == "configure":
        configure(folder)
        return 0
    client = create_client(folder)
    try:
        if args.action == "monitor":
            from monitor import monitor

            await monitor(client, folder, args, save_message, normalize, resolve_channel)
            return 0
        await asyncio.wait_for(client.connect(), timeout=25)
        if args.action == "login":
            await login(client, folder, args.login_method)
            return 0 if await client.is_user_authorized() else 2
        authorized = await client.is_user_authorized()
        if args.action == "status":
            report(connected=client.is_connected(), authorized=authorized,
                   api_config_encrypted=True, session_encrypted=(folder / "session.dpapi").exists())
            return 0
        if not authorized:
            report(authorized=False, next_action="Run Login once on the target computer")
            return 2
        if args.action == "dialogs":
            from telethon import utils

            channels = []
            async for dialog in client.iter_dialogs(limit=args.limit):
                if dialog.is_channel:
                    channels.append({"peer_id": str(utils.get_peer_id(dialog.entity)), "title": dialog.title,
                                     "kind": "group" if dialog.entity.megagroup else "channel"})
            (folder / "channels.json").write_text(json.dumps(channels, ensure_ascii=False, indent=2), encoding="utf-8")
            report(authorized=True, channels=channels)
        elif args.action == "probe":
            await probe(client, folder, args)
        elif args.action == "watch":
            await watch(client, folder, args)
        elif args.action == "history":
            from history import history

            entity = await resolve_channel(client, args.channel)
            await history(client, folder, args, save_message, entity, normalize)
        return 0
    finally:
        await client.disconnect()


def main():
    parser = argparse.ArgumentParser(description="Telegram login and SQLite archive validation; QQ forwarding is disabled")
    parser.add_argument("action", choices=["configure", "login", "status", "dialogs", "probe", "watch", "history", "monitor"])
    parser.add_argument("--config", type=Path, help="Selected source configuration for monitor")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parents[2] / "data" / "telegram")
    parser.add_argument("--channel", help="Selected signed peer_id from the dialogs command")
    parser.add_argument("--limit", type=int, default=5, help="probe/dialogs cap; history scans the entire time window")
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--hours", type=int, default=24)
    parser.add_argument("--until", help="Exclusive ISO-8601 history end time, including UTC offset")
    parser.add_argument("--topic", type=int, help="Forum topic top message ID for history")
    parser.add_argument("--login-method", choices=["qr", "phone"], default="qr")
    args = parser.parse_args()
    if args.action in {"probe", "watch", "history"} and not re.fullmatch(r"-\d+", args.channel or ""):
        parser.error("probe/watch/history requires --channel with a signed peer ID from dialogs")
    if not 1 <= args.limit <= 1000 or args.seconds < 0:
        parser.error("limit must be 1..1000 and seconds must be nonnegative")
    if not 1 <= args.hours <= 720:
        parser.error("hours must be 1..720")
    if args.topic is not None and (args.action != "history" or args.topic < 1):
        parser.error("a positive --topic is supported only for history")
    logging.basicConfig(level=logging.WARNING)
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130
    except Exception as failure:
        report(error=type(failure).__name__, action=args.action)
        return 1


if __name__ == "__main__":
    sys.exit(main())
