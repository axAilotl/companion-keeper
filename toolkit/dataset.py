"""Convert per-conversation JSONL exports into OpenAI-style chat JSONL.

Wraps the logic from build_chat_dataset.py for programmatic use.
"""

from __future__ import annotations

import glob
import json
import os
import re
from typing import Dict, List, Optional, Tuple


IMAGE_PLACEHOLDER = "<image>"


def list_input_files(input_dir: str, recursive: bool = False) -> List[str]:
    pattern = "**/*.jsonl" if recursive else "*.jsonl"
    paths = glob.glob(os.path.join(input_dir, pattern), recursive=recursive)
    paths.sort()
    return paths


def extract_text(
    msg: Dict,
    image_mode: str = "strip",
    placeholder_token: str = IMAGE_PLACEHOLDER,
) -> Tuple[str, bool]:
    text = msg.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip(), False

    parts = msg.get("parts")
    if not isinstance(parts, list):
        return "", False

    had_image = False
    out: List[str] = []
    for part in parts:
        if isinstance(part, str):
            out.append(part)
            continue
        had_image = True
        if image_mode == "placeholder":
            out.append(placeholder_token)

    joined = "".join(out).strip()
    return joined, had_image


def should_keep_message(
    role: str,
    content_type: Optional[str],
    text: str,
    had_image: bool,
    include_system: bool = True,
    drop_empty_system: bool = True,
    drop_user_context: bool = True,
    image_mode: str = "strip",
) -> bool:
    if role not in {"system", "user", "assistant"}:
        return False
    if role == "system" and not include_system:
        return False
    if content_type == "user_editable_context" and drop_user_context:
        return False
    if role == "system" and drop_empty_system and not text:
        return False
    if not text:
        if image_mode == "drop-if-image-only" and had_image:
            return False
        return False
    return True


def merge_consecutive(messages: List[Dict]) -> List[Dict]:
    if not messages:
        return []
    merged: List[Dict] = [messages[0].copy()]
    for msg in messages[1:]:
        last = merged[-1]
        if msg["role"] == last["role"]:
            last["content"] = f"{last['content']}\n\n{msg['content']}".strip()
        else:
            merged.append(msg.copy())
    return merged


def parse_conversation_meta(path: str) -> Dict[str, str]:
    base = os.path.splitext(os.path.basename(path))[0]
    m = re.match(r"^(?P<cid>.+)_(?P<date>\d{8})$", base)
    if not m:
        return {"source_file": os.path.basename(path)}
    return {
        "conversation_id": m.group("cid"),
        "first_message_date": m.group("date"),
        "source_file": os.path.basename(path),
    }


def process_file(
    path: str,
    image_mode: str = "strip",
    placeholder_token: str = IMAGE_PLACEHOLDER,
    do_merge: bool = True,
    min_messages: int = 2,
    require_user: bool = False,
    require_assistant: bool = False,
    include_system: bool = True,
    drop_empty_system: bool = True,
    drop_user_context: bool = True,
    include_meta: bool = False,
) -> Optional[Dict]:
    messages: List[Dict] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue

            role = msg.get("role")
            if not isinstance(role, str):
                continue

            content_type = msg.get("content_type")
            if not isinstance(content_type, str):
                content_type = None

            text, had_image = extract_text(msg, image_mode, placeholder_token)

            if not should_keep_message(
                role, content_type, text, had_image,
                include_system=include_system,
                drop_empty_system=drop_empty_system,
                drop_user_context=drop_user_context,
                image_mode=image_mode,
            ):
                continue

            messages.append({"role": role, "content": text})

    if do_merge:
        messages = merge_consecutive(messages)

    if len(messages) < min_messages:
        return None

    roles = {m["role"] for m in messages}
    if require_user and "user" not in roles:
        return None
    if require_assistant and "assistant" not in roles:
        return None

    item: Dict = {"messages": messages}
    if include_meta:
        item["metadata"] = parse_conversation_meta(path)
    return item


def build_dataset(
    input_dir: str,
    output_file: str,
    recursive: bool = False,
    image_mode: str = "strip",
    max_conversations: int = 0,
    include_meta: bool = False,
    log_fn=None,
) -> Tuple[int, int, int]:
    """Build a chat dataset JSONL from per-conversation exports.

    Returns (total, kept, skipped).
    """
    input_files = list_input_files(input_dir, recursive)
    if not input_files:
        raise RuntimeError(f"No input files found in {input_dir}")

    os.makedirs(os.path.dirname(output_file) or ".", exist_ok=True)

    kept = 0
    skipped = 0
    total = 0

    with open(output_file, "w", encoding="utf-8") as out:
        for path in input_files:
            total += 1
            item = process_file(path, image_mode=image_mode, include_meta=include_meta)
            if item is None:
                skipped += 1
            else:
                out.write(json.dumps(item, ensure_ascii=False))
                out.write("\n")
                kept += 1

            if log_fn and total % 50 == 0:
                log_fn(f"Dataset build: processed {total} files, kept {kept}")

            if max_conversations and kept >= max_conversations:
                break

    return total, kept, skipped
