import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/"scripts"/"telegram"))
from monitor import monitor_lock, monitor_round, read_sources

folder = Path(sys.argv[1])
folder.mkdir(parents=True, exist_ok=True)
messages = []


def normalize(entity, message):
    return {"peer_id": "-1001", "channel_name": "Yekoi", "message_id": str(message.id),
            "source_timestamp": message.date.isoformat(), "body_raw": f"TG fixture {message.id}",
            "edit_timestamp": None, "grouped_id": None, "topic_id": "13", "attachments": []}


async def save(client, archive, entity, message):
    return archive.save(normalize(entity, message))[1]


async def resolve(*args):
    return SimpleNamespace()


async def validate(*args):
    return None


class Client:
    def iter_messages(self, entity, **options):
        async def iterate():
            for message in reversed(messages):
                yield message
        return iterate()


with monitor_lock(folder):
    for line in sys.stdin:
        command = json.loads(line)
        messages.append(SimpleNamespace(id=command["id"], date=datetime.now(timezone.utc)-timedelta(seconds=1)))
        status = asyncio.run(monitor_round(Client(), folder, read_sources(folder/"sources.json"), save,
                                           normalize, resolve, validate))
        print(json.dumps(status), flush=True)
