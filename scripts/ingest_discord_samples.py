"""OCR the three supplied screenshots into daily SQLite archives. No forwarding."""
import argparse
import logging
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from discord_archive.store import add_message, connect, database_path, format_forward, ingest_capture


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--images", type=Path, default=ROOT / "scence_print")
    parser.add_argument("--data", type=Path, default=ROOT / "data")
    args = parser.parse_args()
    from rapidocr import RapidOCR

    logging.disable(logging.CRITICAL)
    ocr = RapidOCR()
    for image in sorted(args.images.glob("*.png")):
        match = re.search(r"(2026-\d\d-\d\d)_(\d\d)(\d\d)(\d\d)", image.name)
        if not match:
            print(f"SKIP {image.name}: filename has no capture time")
            continue
        captured = datetime.strptime(match.group(1) + " " + ":".join(match.groups()[1:]), "%Y-%m-%d %H:%M:%S").replace(tzinfo=ZoneInfo("Asia/Shanghai"))
        db = connect(database_path(args.data, captured))
        try:
            result = ocr(str(image))
            capture_id, inserted = ingest_capture(db, image, captured, result, "交流频道")
            print(f"{image.name}: capture={capture_id}, new={inserted}, lines={len(result.txts or [])}")
            if "193625" in image.name:
                lines = result.txts or []
                body = "\n".join(lines[4:8])
                message_id = add_message(db, capture_id, "交流频道", "豆沙包APP", "17:16", body, [4, 5, 6, 7])
                print(f"sample message={message_id}\n{format_forward('交流频道', '豆沙包APP', '17:16', body)}")
        finally:
            db.close()


if __name__ == "__main__":
    main()
