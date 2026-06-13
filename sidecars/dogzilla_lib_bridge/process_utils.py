from __future__ import annotations

import json
from typing import Any


def summarize_process_text(value: Any, *, limit: int = 500) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    text = str(value).strip()
    if len(text) <= limit:
        return text
    return text[-limit:]


def parse_json_process_output(value: Any) -> dict[str, Any] | None:
    text = summarize_process_text(value, limit=5000)
    if not text:
        return None

    for line in reversed(text.splitlines()):
        candidate = line.strip()
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        return parsed if isinstance(parsed, dict) else None

    return None
