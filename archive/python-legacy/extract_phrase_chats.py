#!/usr/bin/env python3
"""
Extract conversations containing a phrase (case-insensitive by default)
from conversations.json into a separate folder, preserving originals.
Also writes a manifest JSONL with basic metadata.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter
from datetime import datetime, timezone
from typing import Dict, Iterator, List, Optional, Tuple


CHUNK_SIZE = 1024 * 1024  # 1 MB


def iter_json_array(path: str, chunk_size: int = CHUNK_SIZE) -> Iterator[dict]:
    decoder = json.JSONDecoder()
    buf = ""
    with open(path, "r", encoding="utf-8") as f:
        while True:
            if "[" in buf:
                idx = buf.index("[")
                buf = buf[idx + 1 :]
                break
            data = f.read(chunk_size)
            if not data:
                return
            buf += data
            if len(buf) > chunk_size * 2:
                buf = buf[-64:]

        while True:
            i = 0
            while True:
                while i < len(buf) and buf[i] in " \t\r\n,":
                    i += 1
                if i < len(buf):
                    break
                data = f.read(chunk_size)
                if not data:
                    return
                buf = buf[i:] + data
                i = 0

            if i < len(buf) and buf[i] == "]":
                return

            try:
                obj, end = decoder.raw_decode(buf, i)
            except json.JSONDecodeError:
                data = f.read(chunk_size)
                if not data:
                    raise
                buf = buf[i:] + data
                i = 0
                continue

            if isinstance(obj, dict):
                yield obj
            buf = buf[end:]


def iter_messages(convo: dict) -> Iterator[dict]:
    mapping = convo.get("mapping") or {}
    if not isinstance(mapping, dict):
        return
    for node in mapping.values():
        if not isinstance(node, dict):
            continue
        msg = node.get("message")
        if isinstance(msg, dict):
            yield msg


def extract_text_parts(msg: dict) -> List[str]:
    content = msg.get("content") or {}
    parts = content.get("parts")
    if not isinstance(parts, list):
        return []
    texts: List[str] = []
    for part in parts:
        if isinstance(part, str):
            texts.append(part)
    return texts


def first_message_time(convo: dict) -> Optional[float]:
    times = []
    for msg in iter_messages(convo):
        t = msg.get("create_time")
        if isinstance(t, (int, float)):
            times.append(t)
    if times:
        return min(times)
    t = convo.get("create_time")
    if isinstance(t, (int, float)):
        return t
    return None


def format_date(ts: Optional[float]) -> str:
    if ts is None:
        return "unknown-date"
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return dt.strftime("%Y%m%d")


def sanitize_filename(name: str) -> str:
    return re.sub(r"[^\w.\-]+", "_", name).strip("_")


def conversation_contains(
    convo: dict,
    patterns: List[re.Pattern],
    match: str,
) -> Tuple[bool, int]:
    """
    match = "any" -> at least one pattern hits
    match = "all" -> every pattern hits at least once in the conversation
    """
    if not patterns:
        return False, 0

    hits = 0
    found = [False] * len(patterns)

    for msg in iter_messages(convo):
        for text in extract_text_parts(msg):
            for i, pat in enumerate(patterns):
                if pat.search(text):
                    found[i] = True
                    hits += 1

    if match == "all":
        return all(found), hits
    return any(found), hits


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract conversations containing a phrase."
    )
    parser.add_argument(
        "--input",
        default="conversations.json",
        help="Path to conversations.json",
    )
    parser.add_argument(
        "--phrase",
        required=True,
        action="append",
        help="Phrase or regex to match (repeatable).",
    )
    parser.add_argument(
        "--case-insensitive",
        action="store_true",
        default=True,
        help="Case-insensitive matching (default: True).",
    )
    parser.add_argument(
        "--match",
        choices=["any", "all"],
        default="any",
        help="Match mode when multiple phrases provided (default: any).",
    )
    parser.add_argument(
        "--before",
        help="Only include conversations with first message before YYYY-MM-DD.",
    )
    parser.add_argument(
        "--after",
        help="Only include conversations with first message after YYYY-MM-DD.",
    )
    parser.add_argument(
        "--output-dir",
        default=os.path.join("topic_exports", "alignment_through_love"),
        help="Output directory for matching conversations.",
    )
    parser.add_argument(
        "--max-conversations",
        type=int,
        default=0,
        help="Limit number of matches (0 = no limit).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    flags = re.IGNORECASE if args.case_insensitive else 0
    phrases = args.phrase or []
    patterns = [re.compile(p, flags=flags) for p in phrases]

    before_ts = None
    after_ts = None
    if args.before:
        before_dt = datetime.strptime(args.before, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        before_ts = before_dt.timestamp()
    if args.after:
        after_dt = datetime.strptime(args.after, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        after_ts = after_dt.timestamp()

    os.makedirs(args.output_dir, exist_ok=True)
    manifest_path = os.path.join(args.output_dir, "manifest.jsonl")

    total = 0
    matched = 0

    with open(manifest_path, "w", encoding="utf-8") as manifest:
        for convo in iter_json_array(args.input):
            total += 1
            ts = first_message_time(convo)
            if before_ts is not None and ts is not None and ts >= before_ts:
                continue
            if after_ts is not None and ts is not None and ts <= after_ts:
                continue

            has_hit, hit_count = conversation_contains(
                convo, patterns, args.match
            )
            if not has_hit:
                continue

            conv_id = convo.get("conversation_id") or convo.get("id") or "unknown-session"
            conv_id = sanitize_filename(str(conv_id))
            date_str = format_date(first_message_time(convo))
            filename = f"{conv_id}_{date_str}.json"
            out_path = os.path.join(args.output_dir, filename)

            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(convo, f, ensure_ascii=False)

            record = {
                "conversation_id": convo.get("conversation_id"),
                "title": convo.get("title"),
                "create_time": convo.get("create_time"),
                "update_time": convo.get("update_time"),
                "first_message_date": date_str,
                "match_count": hit_count,
                "file": filename,
            }
            manifest.write(json.dumps(record, ensure_ascii=False))
            manifest.write("\n")

            matched += 1
            if args.max_conversations and matched >= args.max_conversations:
                break

    print(f"Done. total={total} matched={matched} output={args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
