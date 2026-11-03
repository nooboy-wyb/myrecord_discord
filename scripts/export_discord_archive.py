"""Export a daily Discord OCR SQLite archive as readable UTF-8 text."""

import argparse
import sqlite3
from pathlib import Path


def export_text(db: sqlite3.Connection) -> str:
    out = ["Discord 采集归档", "=" * 40, "说明：消息分组与原始 OCR 行分别展示；未分组的 OCR 行不代表独立消息。", ""]
    captures = db.execute(
        "SELECT id, captured_at, source_path, channel_hint, ocr_model FROM captures ORDER BY captured_at, id"
    ).fetchall()
    for capture_id, captured_at, source_path, channel, model in captures:
        out.extend([f"截图 #{capture_id} · {captured_at}", f"频道：{channel or '未知'}", f"图片：{source_path}", f"OCR：{model}", "-" * 40])
        messages = db.execute(
            "SELECT id, channel, author_display, displayed_time, body_raw, review_status "
            "FROM messages WHERE capture_id=? ORDER BY id", (capture_id,)
        ).fetchall()
        out.append(f"已分组消息：{len(messages)} 条")
        for message_id, msg_channel, author, displayed_time, body, status in messages:
            out.extend([
                f"[消息 #{message_id} · {status}]",
                f"【Discord｜{msg_channel}】{author} · {displayed_time or '时间未知'}",
                body,
                "",
            ])
        rows = db.execute(
            "SELECT line_index, text_raw, confidence FROM ocr_lines WHERE capture_id=? ORDER BY line_index",
            (capture_id,),
        ).fetchall()
        out.append(f"完整原始 OCR：{len(rows)} 行（包含侧栏、图片文字和已分组消息）")
        for index, raw, score in rows:
            out.append(f"{index + 1:03d} [{score:.3f}] {raw}" if score is not None else f"{index + 1:03d} {raw}")
        out.append("")
    out.append(f"合计：{len(captures)} 张截图")
    return "\n".join(out) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="data/YYYY-MM-DD/messages.sqlite")
    parser.add_argument("-o", "--output", type=Path, help="输出 .txt 路径；省略则写到终端")
    args = parser.parse_args()
    if not args.database.is_file():
        parser.error(f"数据库不存在：{args.database}")
    with sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True) as db:
        result = export_text(db)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result, encoding="utf-8")
        print(f"已导出：{args.output.resolve()}")
    else:
        print(result, end="")


if __name__ == "__main__":
    main()
