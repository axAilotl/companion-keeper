"""Chat export extraction: unzip, analyze, discover models, extract by model.

Supports OpenAI and Anthropic export formats. Auto-detects format by peeking
at the first JSON object in the conversations array.
"""

from __future__ import annotations

import json
import os
import re
import zipfile
from collections import Counter
from datetime import datetime, timezone
from typing import Dict, Iterator, List, Optional, Set, Tuple


CHUNK_SIZE = 1024 * 1024  # 1 MB


def iter_json_array(path: str, chunk_size: int = CHUNK_SIZE) -> Iterator[dict]:
    """Yield items from a top-level JSON array without loading the whole file."""
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


def get_message_model(msg: dict) -> Optional[str]:
    meta = msg.get("metadata") or {}
    if not isinstance(meta, dict):
        return None
    for key in ("model_slug", "default_model_slug", "model"):
        val = meta.get(key)
        if isinstance(val, str) and val:
            return val
    return None


def get_conversation_models(convo: dict) -> Tuple[Set[str], Counter]:
    models: Set[str] = set()
    counts: Counter = Counter()
    for msg in iter_messages(convo):
        role = (msg.get("author") or {}).get("role")
        if role != "assistant":
            continue
        model = get_message_model(msg)
        if model:
            models.add(model)
            counts[model] += 1
    return models, counts


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
    name = re.sub(r"[^\w.\-]+", "_", name)
    return name.strip("_")


def order_messages(convo: dict, roles: Set[str], order: str = "time") -> List[dict]:
    if order == "current-path":
        mapping = convo.get("mapping") or {}
        if not isinstance(mapping, dict):
            return []
        node_id = convo.get("current_node")
        path = []
        while node_id:
            node = mapping.get(node_id)
            if not isinstance(node, dict):
                break
            msg = node.get("message")
            if isinstance(msg, dict):
                role = (msg.get("author") or {}).get("role")
                if role in roles:
                    path.append(msg)
            node_id = node.get("parent")
        return list(reversed(path))

    msgs = []
    for msg in iter_messages(convo):
        role = (msg.get("author") or {}).get("role")
        if role in roles:
            msgs.append(msg)
    msgs.sort(key=lambda m: (m.get("create_time") is not None, m.get("create_time") or 0))
    return msgs


def clean_message(msg: dict) -> dict:
    author = msg.get("author") or {}
    content = msg.get("content") or {}
    role = author.get("role")
    ctype = content.get("content_type")
    parts = content.get("parts")
    text = None
    if isinstance(parts, list):
        if all(isinstance(p, str) for p in parts):
            text = "".join(parts)
        else:
            text = None
    model = get_message_model(msg)
    return {
        "id": msg.get("id"),
        "role": role,
        "name": author.get("name"),
        "create_time": msg.get("create_time"),
        "content_type": ctype,
        "parts": parts,
        "text": text,
        "model": model,
    }


def detect_export_format(path: str) -> str:
    """Peek at first JSON object to determine export format.

    Returns ``"openai"``, ``"anthropic"``, or ``"unknown"``.
    """
    for obj in iter_json_array(path):
        if "mapping" in obj:
            return "openai"
        if "chat_messages" in obj:
            return "anthropic"
        return "unknown"
    return "unknown"


# --- Anthropic export helpers ---

_ANTHROPIC_SENDER_MAP = {"human": "user", "assistant": "assistant"}


def iter_anthropic_messages(convo: dict) -> Iterator[dict]:
    """Yield raw message dicts from an Anthropic conversation."""
    msgs = convo.get("chat_messages")
    if isinstance(msgs, list):
        yield from msgs


def anthropic_clean_message(msg: dict) -> dict:
    """Normalise an Anthropic message to the same shape as ``clean_message()``."""
    sender = msg.get("sender") or ""
    role = _ANTHROPIC_SENDER_MAP.get(sender, sender)

    # Extract text: prefer content blocks (filter to type=="text"), fall back to top-level text
    text = None
    content_blocks = msg.get("content")
    if isinstance(content_blocks, list):
        text_parts = []
        for block in content_blocks:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text")
                if isinstance(t, str):
                    text_parts.append(t)
        if text_parts:
            text = "".join(text_parts)

    if text is None:
        raw = msg.get("text")
        if isinstance(raw, str):
            text = raw

    return {
        "id": msg.get("uuid"),
        "role": role,
        "name": None,
        "create_time": _parse_iso_timestamp(msg.get("created_at")),
        "content_type": "text",
        "parts": [text] if text else [],
        "text": text,
        "model": None,
    }


def _parse_iso_timestamp(ts: str | None) -> float | None:
    """Parse an ISO-8601 timestamp string to a Unix float, or ``None``."""
    if not isinstance(ts, str) or not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.timestamp()
    except (ValueError, OSError):
        return None


def anthropic_first_message_time(convo: dict) -> Optional[float]:
    """Return the earliest message timestamp from an Anthropic conversation."""
    times: list[float] = []
    for msg in iter_anthropic_messages(convo):
        t = _parse_iso_timestamp(msg.get("created_at"))
        if t is not None:
            times.append(t)
    if times:
        return min(times)
    t = _parse_iso_timestamp(convo.get("created_at"))
    return t


def order_anthropic_messages(convo: dict, roles: Set[str]) -> List[dict]:
    """Return cleaned Anthropic messages in chronological order, filtered by role."""
    msgs = []
    for raw in iter_anthropic_messages(convo):
        cleaned = anthropic_clean_message(raw)
        if cleaned["role"] in roles:
            msgs.append(cleaned)
    msgs.sort(key=lambda m: (m.get("create_time") is not None, m.get("create_time") or 0))
    return msgs


def write_anthropic_conversation(
    convo: dict,
    out_dir: str,
    model_dir: str,
    fmt: str = "jsonl",
    roles: Optional[Set[str]] = None,
) -> str:
    """Write an Anthropic conversation to JSONL/JSON, same output shape as ``write_conversation()``."""
    if roles is None:
        roles = {"user", "assistant"}

    conv_id = convo.get("uuid") or convo.get("name") or "unknown-session"
    conv_id = sanitize_filename(str(conv_id))
    date_str = format_date(anthropic_first_message_time(convo))
    base_name = f"{conv_id}_{date_str}"
    ext = "jsonl" if fmt == "jsonl" else "json"

    model_dir_safe = sanitize_filename(model_dir)
    target_dir = os.path.join(out_dir, model_dir_safe)
    os.makedirs(target_dir, exist_ok=True)

    path = os.path.join(target_dir, f"{base_name}.{ext}")
    if os.path.exists(path):
        suffix = 2
        while True:
            candidate = os.path.join(target_dir, f"{base_name}_{suffix}.{ext}")
            if not os.path.exists(candidate):
                path = candidate
                break
            suffix += 1

    messages = order_anthropic_messages(convo, roles)

    if fmt == "json":
        payload = {
            "conversation_id": convo.get("uuid"),
            "title": convo.get("name"),
            "create_time": _parse_iso_timestamp(convo.get("created_at")),
            "update_time": _parse_iso_timestamp(convo.get("updated_at")),
            "messages": messages,
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        return path

    with open(path, "w", encoding="utf-8") as f:
        for item in messages:
            f.write(json.dumps(item, ensure_ascii=False))
            f.write("\n")
    return path


def analyze_structure(path: str, sample: int) -> dict:
    top_keys: Set[str] = set()
    mapping_keys: Set[str] = set()
    message_keys: Set[str] = set()
    author_keys: Set[str] = set()
    content_keys: Set[str] = set()
    metadata_keys: Set[str] = set()
    content_types: Counter = Counter()
    roles: Counter = Counter()

    count = 0
    for convo in iter_json_array(path):
        count += 1
        for k in convo.keys():
            top_keys.add(k)
        mapping = convo.get("mapping") or {}
        if isinstance(mapping, dict):
            for node in mapping.values():
                if not isinstance(node, dict):
                    continue
                for k in node.keys():
                    mapping_keys.add(k)
                msg = node.get("message")
                if not isinstance(msg, dict):
                    continue
                for k in msg.keys():
                    message_keys.add(k)
                author = msg.get("author") or {}
                if isinstance(author, dict):
                    for k in author.keys():
                        author_keys.add(k)
                    role = author.get("role")
                    if role:
                        roles[role] += 1
                content = msg.get("content") or {}
                if isinstance(content, dict):
                    for k in content.keys():
                        content_keys.add(k)
                    ctype = content.get("content_type")
                    if ctype:
                        content_types[ctype] += 1
                meta = msg.get("metadata") or {}
                if isinstance(meta, dict):
                    for k in meta.keys():
                        metadata_keys.add(k)
        if count >= sample:
            break

    return {
        "sample_size": count,
        "top_level_keys": sorted(top_keys),
        "mapping_node_keys": sorted(mapping_keys),
        "message_keys": sorted(message_keys),
        "author_keys": sorted(author_keys),
        "content_keys": sorted(content_keys),
        "metadata_keys_sample": sorted(metadata_keys),
        "content_types_sample": dict(content_types.most_common()),
        "roles_sample": dict(roles.most_common()),
    }


def discover_models(path: str) -> Tuple[Counter, Counter]:
    fmt = detect_export_format(path)

    if fmt == "anthropic":
        msg_count = 0
        convo_count = 0
        for convo in iter_json_array(path):
            convo_count += 1
            msgs = convo.get("chat_messages")
            if isinstance(msgs, list):
                msg_count += len(msgs)
        return Counter({"claude": msg_count}), Counter({"claude": convo_count})

    # OpenAI (default)
    msg_counts: Counter = Counter()
    convo_counts: Counter = Counter()
    for convo in iter_json_array(path):
        conv_models, counts = get_conversation_models(convo)
        for m, c in counts.items():
            msg_counts[m] += c
        for m in conv_models:
            convo_counts[m] += 1
    return msg_counts, convo_counts


def parse_models_arg(value: Optional[str]) -> List[str]:
    if not value:
        return []
    parts = re.split(r"[,\s]+", value.strip())
    return [p for p in parts if p]


def write_conversation(
    convo: dict,
    out_dir: str,
    model_dir: str,
    fmt: str = "jsonl",
    roles: Optional[Set[str]] = None,
    order: str = "time",
    include_raw: bool = False,
    include_metadata: bool = False,
) -> str:
    if roles is None:
        roles = {"system", "user", "assistant"}
    conv_id = convo.get("conversation_id") or convo.get("id") or "unknown-session"
    conv_id = sanitize_filename(str(conv_id))
    date_str = format_date(first_message_time(convo))
    base_name = f"{conv_id}_{date_str}"
    ext = "jsonl" if fmt == "jsonl" else "json"

    model_dir_safe = sanitize_filename(model_dir)
    target_dir = os.path.join(out_dir, model_dir_safe)
    os.makedirs(target_dir, exist_ok=True)

    path = os.path.join(target_dir, f"{base_name}.{ext}")
    if os.path.exists(path):
        suffix = 2
        while True:
            candidate = os.path.join(target_dir, f"{base_name}_{suffix}.{ext}")
            if not os.path.exists(candidate):
                path = candidate
                break
            suffix += 1

    messages = order_messages(convo, roles, order=order)

    if fmt == "json":
        items = []
        for msg in messages:
            if include_raw:
                item = msg
            else:
                item = clean_message(msg)
                if include_metadata:
                    item["metadata"] = msg.get("metadata")
            items.append(item)
        payload = {
            "conversation_id": convo.get("conversation_id"),
            "title": convo.get("title"),
            "create_time": convo.get("create_time"),
            "update_time": convo.get("update_time"),
            "messages": items,
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        return path

    with open(path, "w", encoding="utf-8") as f:
        for msg in messages:
            if include_raw:
                item = msg
            else:
                item = clean_message(msg)
                if include_metadata:
                    item["metadata"] = msg.get("metadata")
            f.write(json.dumps(item, ensure_ascii=False))
            f.write("\n")
    return path


# --- High-level operations ---

def unzip_export(zip_path: str, output_dir: str) -> str:
    """Unzip an OpenAI export ZIP and return status message."""
    zip_path = (zip_path or "").strip()
    output_dir = (output_dir or "").strip()
    if not zip_path:
        return "Error: zip path is required."
    if not os.path.isfile(zip_path):
        return f"Error: zip file not found at {zip_path}"
    if not output_dir:
        return "Error: output dir is required."

    os.makedirs(output_dir, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(output_dir)

    convo_path = os.path.join(output_dir, "conversations.json")
    if os.path.isfile(convo_path):
        return f"Unpacked successfully.\nconversations.json: {convo_path}"
    return (
        "Unpacked successfully, but conversations.json was not found at the zip root.\n"
        f"Check output dir: {output_dir}"
    )


def resolve_conversations_path(input_path: str) -> Tuple[str, str]:
    """Given a path to a ZIP or conversations.json, return (conversations_json_path, log).

    If it's a ZIP, auto-unzips to a sibling directory.
    """
    input_path = (input_path or "").strip()
    if not input_path:
        return "", "Error: input path is required."
    if not os.path.exists(input_path):
        return "", f"Error: path not found: {input_path}"

    if input_path.lower().endswith(".zip"):
        base = os.path.splitext(os.path.basename(input_path))[0]
        out_dir = os.path.join(os.path.dirname(input_path) or ".", f"imports/{base}")
        msg = unzip_export(input_path, out_dir)
        convo_path = os.path.join(out_dir, "conversations.json")
        if os.path.isfile(convo_path):
            return convo_path, msg
        return "", msg

    if os.path.isfile(input_path):
        return input_path, f"Using existing file: {input_path}"

    return "", f"Error: not a file: {input_path}"


def extract_by_models(
    conversations_path: str,
    models: List[str],
    output_dir: str = "model_exports",
    max_conversations: int = 0,
    fmt: str = "jsonl",
    roles: Optional[Set[str]] = None,
    order: str = "time",
    log_fn=None,
) -> Tuple[int, str]:
    """Extract conversations matching given models. Returns (count, output_dir)."""
    if roles is None:
        roles = {"system", "user", "assistant"}

    export_fmt = detect_export_format(conversations_path)

    if export_fmt == "anthropic":
        # Anthropic exports have no per-message model data; extract all to "claude/"
        anthropic_roles = {"user", "assistant"}
        extracted = 0
        for convo in iter_json_array(conversations_path):
            write_anthropic_conversation(convo, output_dir, "claude", fmt, anthropic_roles)
            extracted += 1
            if log_fn:
                log_fn(f"Extracted {extracted} conversations...")
            if max_conversations and extracted >= max_conversations:
                break
        return extracted, output_dir

    # OpenAI format
    models_set = set(models)
    extracted = 0

    for convo in iter_json_array(conversations_path):
        conv_models, counts = get_conversation_models(convo)
        matched = conv_models.intersection(models_set)
        if not matched:
            continue

        if len(matched) == 1:
            primary = next(iter(matched))
        else:
            primary = max(matched, key=lambda m: (counts.get(m, 0), m))

        write_conversation(convo, output_dir, primary, fmt, roles, order)
        extracted += 1
        if log_fn:
            log_fn(f"Extracted {extracted} conversations...")
        if max_conversations and extracted >= max_conversations:
            break

    return extracted, output_dir
