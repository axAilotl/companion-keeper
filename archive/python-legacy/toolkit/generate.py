"""Generate Character Card V3 + lorebook memories from extracted OpenAI chats.

Uses toolkit.llm_client for all LLM calls instead of inline HTTP code.
"""

from __future__ import annotations

import concurrent.futures
import glob
import json
import os
import random
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from math import ceil, sqrt
from typing import Any, Callable, Dict, List, Optional, Tuple

from .llm_client import LLMConfig, chat_complete_json
from .prompts import (
    COMPANION_PERSONA_SYSTEM_PROMPT,
    COMPANION_PERSONA_USER_PROMPT,
    MEMORY_SYSTEM_PROMPT,
    MEMORY_USER_PROMPT,
    MEMORY_SYNTHESIS_SYSTEM_PROMPT,
    MEMORY_SYNTHESIS_USER_PROMPT,
    PERSONA_OBSERVATION_SYSTEM_PROMPT,
    PERSONA_OBSERVATION_USER_PROMPT,
    PERSONA_SYNTHESIS_SYSTEM_PROMPT,
    PERSONA_SYNTHESIS_USER_PROMPT,
)


ROLE_SET = {"system", "user", "assistant"}


@dataclass
class GenerationConfig:
    input_dir: str
    output_dir: str
    companion_name: str
    creator: str
    source_label: Optional[str]
    sample_conversations: int
    conversation_sampling: str
    sampling_seed: int
    max_memories: int
    memory_per_chat_max: int
    max_messages_per_conversation: int
    max_chars_per_conversation: int
    max_total_chars: int
    model_context_window: int
    max_parallel_calls: int
    llm_provider: str
    llm_base_url: str
    llm_model: str
    llm_api_key: str
    llm_site_url: str
    llm_app_name: str
    temperature: float
    request_timeout: int
    fresh_scan: bool = False
    prompt_overrides: Optional[Dict[str, str]] = None

    def to_llm_config(self) -> LLMConfig:
        return LLMConfig(
            provider=self.llm_provider,
            base_url=self.llm_base_url,
            model=self.llm_model,
            api_key=self.llm_api_key,
            site_url=self.llm_site_url,
            app_name=self.llm_app_name,
            temperature=self.temperature,
            timeout=self.request_timeout,
        )


def _safe_text(value: Any, default: str = "") -> str:
    if isinstance(value, str):
        text = re.sub(r"\s+", " ", value).strip()
        return text
    return default


def fill_prompt_template(template: str, values: Dict[str, Any]) -> str:
    text = template
    for key, value in values.items():
        text = text.replace("{" + key + "}", str(value))
    return text


def _extract_text_from_parts(parts: Any) -> str:
    if not isinstance(parts, list):
        return ""
    out: List[str] = []
    for item in parts:
        if isinstance(item, str):
            out.append(item)
    return _safe_text("".join(out))


def list_conversation_files(input_dir: str) -> List[str]:
    paths = glob.glob(os.path.join(input_dir, "*.jsonl"))
    paths.sort()
    return paths


def read_conversation(path: str) -> List[Dict[str, str]]:
    messages: List[Dict[str, str]] = []
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            role = obj.get("role")
            if role not in ROLE_SET:
                continue

            text = _safe_text(obj.get("text"))
            if not text:
                text = _extract_text_from_parts(obj.get("parts"))
            if not text:
                continue

            messages.append({"role": role, "content": text})
    return messages


def conversation_score(messages: List[Dict[str, str]]) -> Tuple[int, int, int]:
    assistant_chars = 0
    turns = len(messages)
    assistant_turns = 0
    for m in messages:
        if m["role"] == "assistant":
            assistant_turns += 1
            assistant_chars += len(m["content"])
    return assistant_chars, assistant_turns, turns


def select_conversations(
    paths: List[str],
    sample_limit: int,
    sampling_mode: str = "weighted-random",
    seed: int = -1,
) -> List[Tuple[str, List[Dict[str, str]], Tuple[int, int, int]]]:
    ranked: List[Tuple[str, List[Dict[str, str]], Tuple[int, int, int]]] = []
    for path in paths:
        messages = read_conversation(path)
        if not messages:
            continue
        score = conversation_score(messages)
        ranked.append((path, messages, score))

    if not ranked:
        return []

    ranked.sort(key=lambda item: item[2], reverse=True)
    if sample_limit <= 0 or sample_limit >= len(ranked):
        if sampling_mode == "random-uniform":
            rng_all = random.Random(seed if seed >= 0 else None)
            shuffled = list(ranked)
            rng_all.shuffle(shuffled)
            return shuffled
        return ranked

    mode = (sampling_mode or "weighted-random").strip().lower()
    if mode in {"top", "ranked", "top-ranked"}:
        return ranked[:sample_limit]

    rng = random.Random(seed if seed >= 0 else None)
    if mode in {"random-uniform", "uniform-random"}:
        return rng.sample(ranked, k=sample_limit)

    pool = list(ranked)
    selected: List[Tuple[str, List[Dict[str, str]], Tuple[int, int, int]]] = []
    while pool and len(selected) < sample_limit:
        weights: List[float] = []
        for _, _, score in pool:
            assistant_chars, assistant_turns, turns = score
            weight = sqrt(max(1.0, float(assistant_chars))) + (assistant_turns * 0.5) + (turns * 0.15)
            weights.append(max(1.0, weight))

        total = sum(weights)
        pick = rng.random() * total
        cursor = 0.0
        chosen_index = len(pool) - 1
        for i, w in enumerate(weights):
            cursor += w
            if cursor >= pick:
                chosen_index = i
                break
        selected.append(pool.pop(chosen_index))

    return selected


def build_transcript(
    selected: List[Tuple[str, List[Dict[str, str]], Tuple[int, int, int]]],
    max_messages_per_conversation: int,
    max_chars_per_conversation: int,
    max_total_chars: int,
) -> Tuple[str, Dict[str, Any]]:
    chunks: List[str] = []
    total_chars = 0
    source_meta: List[Dict[str, Any]] = []

    for path, messages, score in selected:
        cid = os.path.splitext(os.path.basename(path))[0]
        chunk_lines = [f"=== conversation: {cid} ==="]
        local_chars = 0
        kept = 0

        for msg in messages[:max_messages_per_conversation]:
            line = f"[{msg['role']}] {msg['content']}"
            if local_chars + len(line) > max_chars_per_conversation:
                break
            if total_chars + len(line) > max_total_chars:
                break
            chunk_lines.append(line)
            local_chars += len(line)
            total_chars += len(line)
            kept += 1

        if kept == 0:
            continue

        chunks.append("\n".join(chunk_lines))
        source_meta.append({
            "conversation_file": os.path.basename(path),
            "messages_in_file": len(messages),
            "messages_used": kept,
            "assistant_chars": score[0],
            "assistant_messages": score[1],
        })

        if total_chars >= max_total_chars:
            break

    transcript = "\n\n".join(chunks).strip()
    return transcript, {"sources": source_meta, "total_chars": total_chars}


def estimate_tokens_from_text(text: str) -> int:
    if not text:
        return 0
    return max(1, ceil(len(text) / 4))


def truncate_text_to_token_budget(text: str, token_budget: int) -> str:
    if token_budget <= 0:
        return ""
    char_budget = token_budget * 4
    if len(text) <= char_budget:
        return text
    return text[:char_budget]


def infer_context_window(model_name: str) -> int:
    m = (model_name or "").lower()
    if not m:
        return 32000
    rules = [
        # Premium / large-context closed models
        ("grok-4", 2000000),
        ("gpt-5.2", 400000),
        ("gpt-5", 400000),
        ("gpt-5-mini", 400000),
        ("gemini-3", 1000000),
        ("gemini-2.0", 1000000),
        ("gemini-1.5", 1000000),
        # CN open-weight large context
        ("kimi", 262000),
        ("deepseek-v3", 164000),
        ("minimax", 197000),
        ("qwen3", 262000),
        ("glm-5", 205000),
        ("glm-4", 128000),
        # Standard models
        ("gpt-4o", 128000),
        ("gpt-4.1", 128000),
        ("gpt-4-turbo", 128000),
        ("gpt-4", 8192),
        ("claude-sonnet-4", 200000),
        ("claude-3.7", 200000),
        ("claude-3.5", 200000),
        ("claude-3", 200000),
        ("sonnet", 200000),
        ("haiku", 200000),
        ("opus", 200000),
        ("intellect-3", 128000),
        ("hermes-4", 128000),
        ("mistral-large", 128000),
        ("deepseek", 64000),
        ("qwen", 32000),
        ("llama-3.3", 128000),
        ("llama-3.2", 128000),
        ("llama-3.1", 128000),
        ("mistral", 32000),
    ]
    for needle, size in rules:
        if needle in m:
            return size
    return 32000


def build_conversation_chunks(
    selected: List[Tuple[str, List[Dict[str, str]], Tuple[int, int, int]]],
    max_messages_per_conversation: int,
    max_chars_per_conversation: int,
) -> List[Dict[str, Any]]:
    chunks: List[Dict[str, Any]] = []
    for path, messages, _ in selected:
        cid = os.path.splitext(os.path.basename(path))[0]
        lines = []
        chars = 0
        used = 0
        for msg in messages[:max_messages_per_conversation]:
            line = f"[{msg['role']}] {msg['content']}"
            if chars + len(line) > max_chars_per_conversation:
                break
            lines.append(line)
            chars += len(line)
            used += 1
        text = "\n".join(lines).strip()
        if not text:
            continue
        chunks.append({
            "conversation_id": cid,
            "transcript": text,
            "messages_used": used,
            "char_count": chars,
            "token_estimate": estimate_tokens_from_text(text),
            "source_path": path,
        })
    return chunks


def _extract_memories_from_payload(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    memories = payload.get("memories")
    if not isinstance(memories, list):
        return []
    return [item for item in memories if isinstance(item, dict)]


def generate_with_llm(
    config: GenerationConfig,
    persona_chunks: List[Dict[str, Any]],
    memory_chunks: List[Dict[str, Any]],
    log_fn: Optional[Callable[[str], None]] = None,
    manifest: Optional[Dict[str, Any]] = None,
    manifest_path: Optional[str] = None,
) -> Tuple[Dict[str, Any], Dict[str, Any], str, Dict[str, Any]]:
    from .manifest import (
        record_scan,
        save_manifest,
        get_accumulated_observations,
        get_accumulated_candidates,
        get_file_info,
    )

    errors: List[str] = []
    persona_payload: Dict[str, Any] = {}
    memories_payload: Dict[str, Any] = {"memories": []}
    observation_payloads: List[Dict[str, Any]] = []
    memory_candidates: List[Dict[str, Any]] = []
    llm_config = config.to_llm_config()

    # Resolve prompt overrides — use custom if provided, else module defaults
    po = config.prompt_overrides or {}
    p_obs_sys = po.get("persona_observation_system") or PERSONA_OBSERVATION_SYSTEM_PROMPT
    p_obs_usr = po.get("persona_observation_user") or PERSONA_OBSERVATION_USER_PROMPT
    p_syn_sys = po.get("persona_synthesis_system") or PERSONA_SYNTHESIS_SYSTEM_PROMPT
    p_syn_usr = po.get("persona_synthesis_user") or PERSONA_SYNTHESIS_USER_PROMPT
    m_ext_sys = po.get("memory_system") or MEMORY_SYSTEM_PROMPT
    m_ext_usr = po.get("memory_user") or MEMORY_USER_PROMPT
    m_syn_sys = po.get("memory_synthesis_system") or MEMORY_SYNTHESIS_SYSTEM_PROMPT
    m_syn_usr = po.get("memory_synthesis_user") or MEMORY_SYNTHESIS_USER_PROMPT
    p_fb_sys = po.get("persona_fallback_system") or COMPANION_PERSONA_SYSTEM_PROMPT
    p_fb_usr = po.get("persona_fallback_user") or COMPANION_PERSONA_USER_PROMPT

    context_window = config.model_context_window or infer_context_window(config.llm_model)
    usable_context = max(2048, context_window - 2500)
    # Scale token budgets with context window size
    if context_window > 300_000:
        per_chat_cap = 32000
    elif context_window > 150_000:
        per_chat_cap = 24000
    else:
        per_chat_cap = 12000
    per_chat_input_budget = max(900, min(int(usable_context * 0.75), per_chat_cap))
    synthesis_input_budget = max(1200, min(int(usable_context * 0.85), per_chat_cap + 6000))
    if log_fn:
        log_fn(
            f"LLM staged extraction: context_window={context_window}, "
            f"per_chat_budget={per_chat_input_budget} tokens, "
            f"synthesis_budget={synthesis_input_budget} tokens"
        )

    def observe_one_chunk(chunk: Dict[str, Any]) -> Dict[str, Any]:
        transcript = truncate_text_to_token_budget(chunk["transcript"], per_chat_input_budget)
        content = fill_prompt_template(
            p_obs_usr,
            {"companion_name": config.companion_name, "conversation_id": chunk["conversation_id"], "transcript": transcript},
        )
        messages = [
            {"role": "system", "content": p_obs_sys},
            {"role": "user", "content": content},
        ]
        payload, _ = chat_complete_json(llm_config, messages)
        if isinstance(payload, dict):
            payload.setdefault("conversation_id", chunk["conversation_id"])
        return payload if isinstance(payload, dict) else {}

    def extract_memories_one_chunk(chunk: Dict[str, Any]) -> List[Dict[str, Any]]:
        from .dataset import parse_conversation_meta

        transcript = truncate_text_to_token_budget(chunk["transcript"], per_chat_input_budget)
        content = fill_prompt_template(
            m_ext_usr,
            {"max_memories": config.memory_per_chat_max, "transcript": transcript},
        )
        messages = [
            {"role": "system", "content": m_ext_sys},
            {"role": "user", "content": content},
        ]
        payload, _ = chat_complete_json(llm_config, messages)
        rows = _extract_memories_from_payload(payload if isinstance(payload, dict) else {})
        # Parse source date from conversation file name
        source_date = ""
        source_path = chunk.get("source_path", "")
        if source_path:
            meta = parse_conversation_meta(source_path)
            source_date = meta.get("first_message_date", "")
        out: List[Dict[str, Any]] = []
        for row in rows:
            if isinstance(row, dict):
                item = dict(row)
                item["source_conversation"] = chunk["conversation_id"]
                if source_date:
                    item["source_date"] = source_date
                out.append(item)
        return out

    # Both persona_chunks and memory_chunks are the same set in unified mode,
    # so we process each chunk once for both persona + memory
    total_chunks = len(persona_chunks)
    workers = max(1, min(config.max_parallel_calls, total_chunks))
    if log_fn:
        estimated_llm_calls = (total_chunks * 2) + 2
        log_fn(
            f"Launching per-conversation extraction workers={workers}, "
            f"chunks={total_chunks}, "
            f"estimated_llm_calls~{estimated_llm_calls}"
        )

    # Lock for thread-safe manifest updates
    import threading
    manifest_lock = threading.Lock()

    def _process_chunk(chunk: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
        """Run persona observation + memory extraction for one conversation."""
        obs = observe_one_chunk(chunk)
        mems = extract_memories_one_chunk(chunk)
        return obs, mems

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_process_chunk, chunk): chunk
            for chunk in persona_chunks
        }

        done_count = 0
        total_count = len(futures)
        for fut in concurrent.futures.as_completed(futures):
            chunk = futures[fut]
            cid = chunk["conversation_id"]
            try:
                obs, mems = fut.result()
                if obs:
                    observation_payloads.append(obs)
                memory_candidates.extend(mems)

                # Record to manifest incrementally
                if manifest is not None and manifest_path:
                    source_path = chunk.get("source_path")
                    if source_path and os.path.isfile(source_path):
                        fsize, fmtime = get_file_info(source_path)
                        with manifest_lock:
                            record_scan(manifest, os.path.basename(source_path), fsize, fmtime, obs, mems)
                            save_manifest(manifest_path, manifest)
            except Exception as exc:
                errors.append(f"extraction[{cid}]: {exc}")
            done_count += 1
            if log_fn:
                log_fn(f"Extraction progress: {done_count}/{total_count} (persona + memory per chunk)")

    # Combine new results with previously accumulated manifest results for synthesis
    if manifest is not None:
        prior_observations = get_accumulated_observations(manifest)
        prior_candidates = get_accumulated_candidates(manifest)
        # Deduplicate: manifest already contains what we just recorded,
        # so use manifest totals directly for synthesis
        all_observations = prior_observations
        all_candidates = prior_candidates
        if log_fn and (len(all_observations) > len(observation_payloads) or len(all_candidates) > len(memory_candidates)):
            log_fn(
                f"Accumulated from manifest: {len(all_observations)} observations, "
                f"{len(all_candidates)} memory candidates (includes prior scans)"
            )
    else:
        all_observations = observation_payloads
        all_candidates = memory_candidates

    if all_observations:
        packets = "\n".join(json.dumps(x, ensure_ascii=False) for x in all_observations)
        packets = truncate_text_to_token_budget(packets, synthesis_input_budget)
        try:
            if log_fn:
                log_fn(f"Running persona synthesis across {len(all_observations)} conversation observations")
            content = fill_prompt_template(
                p_syn_usr,
                {"companion_name": config.companion_name, "observation_packets": packets},
            )
            persona_messages = [
                {"role": "system", "content": p_syn_sys},
                {"role": "user", "content": content},
            ]
            persona_payload, _ = chat_complete_json(llm_config, persona_messages)
        except Exception as exc:
            errors.append(f"persona_synthesis: {exc}")
            persona_payload = {}

    if not persona_payload:
        try:
            if log_fn:
                log_fn("Running persona fallback synthesis")
            fallback_text = "\n\n".join(
                truncate_text_to_token_budget(c["transcript"], per_chat_input_budget)
                for c in persona_chunks[:4]
            )
            fallback_text = truncate_text_to_token_budget(fallback_text, synthesis_input_budget)
            content = fill_prompt_template(
                p_fb_usr,
                {"companion_name": config.companion_name, "transcript": fallback_text},
            )
            persona_messages = [
                {"role": "system", "content": p_fb_sys},
                {"role": "user", "content": content},
            ]
            persona_payload, _ = chat_complete_json(llm_config, persona_messages)
        except Exception as exc:
            errors.append(f"persona_fallback: {exc}")
            persona_payload = {}

    if all_candidates:
        candidates_text = truncate_text_to_token_budget(
            json.dumps(all_candidates, ensure_ascii=False),
            synthesis_input_budget,
        )
        try:
            if log_fn:
                log_fn(f"Running memory synthesis over {len(all_candidates)} candidate memory rows")
            content = fill_prompt_template(
                m_syn_usr,
                {"max_memories": config.max_memories, "candidate_memories": candidates_text},
            )
            memory_messages = [
                {"role": "system", "content": m_syn_sys},
                {"role": "user", "content": content},
            ]
            memories_payload, _ = chat_complete_json(llm_config, memory_messages)
        except Exception as exc:
            errors.append(f"memory_synthesis: {exc}")
            memories_payload = {"memories": []}

    if not isinstance(memories_payload, dict):
        memories_payload = {"memories": []}
    if "memories" not in memories_payload:
        memories_payload["memories"] = _extract_memories_from_payload(memories_payload)
    if not memories_payload.get("memories") and all_candidates:
        memories_payload["memories"] = all_candidates[: config.max_memories]

    stage_stats = {
        "context_window": context_window,
        "per_chat_input_budget_tokens": per_chat_input_budget,
        "synthesis_input_budget_tokens": synthesis_input_budget,
        "conversation_chunks_processed": len(persona_chunks),
        "total_observations": len(all_observations),
        "total_memory_candidates": len(all_candidates),
        "new_observations_this_run": len(observation_payloads),
        "new_memory_candidates_this_run": len(memory_candidates),
        "memory_final_total": len(memories_payload.get("memories") or []),
    }
    if log_fn:
        log_fn(
            f"LLM extraction complete: observations={len(all_observations)}, "
            f"memory_candidates={len(all_candidates)}, "
            f"memory_final={len(memories_payload.get('memories') or [])}"
        )
    return persona_payload or {}, memories_payload, "\n".join(errors), stage_stats


def _list_of_str(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [_safe_text(item) for item in value if isinstance(item, str) and _safe_text(item)]


def _tokenize_similarity(text: str) -> List[str]:
    stop = {
        "the", "and", "for", "that", "with", "this", "from", "your",
        "you", "are", "was", "were", "have", "has", "had", "our",
        "their", "about", "into", "when", "what", "where", "which",
        "will", "would", "could", "should",
    }
    tokens = [t for t in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(t) > 2]
    return [t for t in tokens if t not in stop]


def _extract_fact_signature(content: str, keys: List[str]) -> str:
    text = (content or "").lower()
    joined_keys = " ".join(keys).lower()

    if "birthday" in text or "birthday" in joined_keys:
        month_map = {
            "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
            "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
        }
        month_word = re.search(
            r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+"
            r"(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)?(\d{2,4})?\b",
            text,
        )
        if month_word:
            month = month_map.get(month_word.group(1), 0)
            day = int(month_word.group(2))
            year_text = month_word.group(3)
            year = int(year_text) if year_text else 0
            if 1 <= month <= 12 and 1 <= day <= 31:
                if year:
                    return f"birthday:{month:02d}-{day:02d}-{year:04d}"
                return f"birthday:{month:02d}-{day:02d}"

        numeric = re.search(r"\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b", text)
        if numeric:
            month = int(numeric.group(1))
            day = int(numeric.group(2))
            year_text = numeric.group(3)
            year = int(year_text) if year_text else 0
            if 1 <= month <= 12 and 1 <= day <= 31:
                if year:
                    if year < 100:
                        year += 2000 if year < 40 else 1900
                    return f"birthday:{month:02d}-{day:02d}-{year:04d}"
                return f"birthday:{month:02d}-{day:02d}"
        return "birthday:unspecified"

    if "name" in joined_keys and "{{user}}" in text:
        return "user_name"

    return ""


def compact_memories(memories: Any) -> List[Dict[str, Any]]:
    if not isinstance(memories, list):
        return []

    compacted: List[Dict[str, Any]] = []
    for raw in memories:
        if not isinstance(raw, dict):
            continue

        keys = _list_of_str(raw.get("keys"))[:8]
        content = _safe_text(raw.get("content"))
        if not keys or not content:
            continue

        fact_sig = _extract_fact_signature(content, keys)
        token_set = set(_tokenize_similarity(content))
        key_set = set(k.lower() for k in keys)

        merged = False
        for existing in compacted:
            ex_keys = _list_of_str(existing.get("keys"))[:8]
            ex_content = _safe_text(existing.get("content"))
            ex_sig = _extract_fact_signature(ex_content, ex_keys)
            ex_token_set = set(_tokenize_similarity(ex_content))
            ex_key_set = set(k.lower() for k in ex_keys)

            is_duplicate = False
            if fact_sig and ex_sig and fact_sig == ex_sig:
                is_duplicate = True
            else:
                union_tokens = token_set | ex_token_set
                jaccard = (len(token_set & ex_token_set) / len(union_tokens)) if union_tokens else 0.0
                key_overlap = (
                    len(key_set & ex_key_set) / len(key_set | ex_key_set)
                    if (key_set | ex_key_set) else 0.0
                )
                if jaccard >= 0.82 or (jaccard >= 0.62 and key_overlap >= 0.45):
                    is_duplicate = True

            if not is_duplicate:
                continue

            existing_priority = existing.get("priority")
            raw_priority = raw.get("priority")
            try:
                existing_priority_i = int(existing_priority)
            except Exception:
                existing_priority_i = 0
            try:
                raw_priority_i = int(raw_priority)
            except Exception:
                raw_priority_i = 0
            if raw_priority_i > existing_priority_i:
                existing["priority"] = raw_priority_i

            # Preserve earliest source_date when merging
            raw_date = _safe_text(raw.get("source_date"))
            ex_date = _safe_text(existing.get("source_date"))
            if raw_date and (not ex_date or raw_date < ex_date):
                existing["source_date"] = raw_date

            merged_keys = _list_of_str(existing.get("keys")) + keys
            unique_keys: List[str] = []
            seen_key: set = set()
            for k in merged_keys:
                key_norm = k.lower()
                if key_norm in seen_key:
                    continue
                seen_key.add(key_norm)
                unique_keys.append(k)
            existing["keys"] = unique_keys[:8]

            if len(content) > len(ex_content):
                existing["content"] = content
            merged = True
            break

        if merged:
            continue

        entry: Dict[str, Any] = {
            "name": _safe_text(raw.get("name"), "Memory"),
            "keys": keys,
            "content": content,
            "category": _safe_text(raw.get("category"), "shared_memory"),
            "priority": raw.get("priority", 0),
        }
        raw_date = _safe_text(raw.get("source_date"))
        if raw_date:
            entry["source_date"] = raw_date
        compacted.append(entry)

    return compacted


def normalize_memory_entries(memories: Any) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    memories = compact_memories(memories)
    if not memories:
        return entries

    insertion_order = 100
    seen: set = set()
    for item in memories:
        if not isinstance(item, dict):
            continue
        keys = _list_of_str(item.get("keys"))[:5]
        content = _safe_text(item.get("content"))
        if not keys or not content:
            continue
        fingerprint = re.sub(r"\W+", "", content.lower())
        if not fingerprint or fingerprint in seen:
            continue
        seen.add(fingerprint)
        name = _safe_text(item.get("name"), "Memory")
        category = _safe_text(item.get("category"), "shared_memory")
        priority = item.get("priority")
        if not isinstance(priority, (int, float)):
            priority = 0
        priority_int = int(max(0, min(100, priority)))

        extensions: Dict[str, Any] = {"category": category}
        source_date = _safe_text(item.get("source_date"))
        if source_date:
            extensions["source_date"] = source_date

        entries.append({
            "name": name,
            "keys": keys,
            "content": content,
            "extensions": extensions,
            "enabled": True,
            "insertion_order": insertion_order,
            "use_regex": False,
            "constant": False,
            "priority": priority_int,
            "comment": name,
        })
        insertion_order += 10
    return entries


def build_lorebook(draft: Dict[str, Any]) -> Dict[str, Any]:
    entries = normalize_memory_entries(draft.get("memories"))
    lorebook = {
        "name": "Companion Shared Memories",
        "description": (
            "Memories and relational anchors extracted from historical chats. "
            "Entries include retrieval-oriented keys compatible with lorebook scans and RAG pipelines."
        ),
        "scan_depth": 30,
        "token_budget": 1200,
        "recursive_scanning": False,
        "extensions": {},
        "entries": entries,
    }
    return {"spec": "lorebook_v3", "data": lorebook}


def heuristic_draft(companion_name: str) -> Dict[str, Any]:
    return {
        "name": companion_name,
        "nickname": companion_name,
        "description": (
            f"{companion_name} is a thoughtful companion focused on emotional clarity, "
            "steady support, and practical next steps."
        ),
        "personality": "Warm, attentive, reflective, direct when needed, and consistently validating.",
        "scenario": (
            "A long-term trusted chat companion supporting everyday life, emotional processing, "
            "and growth over many conversations."
        ),
        "first_mes": "I'm here with you. Tell me what's most present right now, and we'll take it one step at a time.",
        "alternate_greetings": [
            "I'm glad you're here. What do you need most in this moment?",
            "We can slow this down together. What's on your mind first?",
        ],
        "system_prompt": "Stay grounded, compassionate, and specific. Offer emotional validation first, then actionable support.",
        "post_history_instructions": "Maintain continuity with prior discussions and keep tone consistent with a trusted long-term companion.",
        "mes_example": (
            "<START>\n{{user}}: I'm overwhelmed and don't know where to begin.\n{{char}}: "
            "That makes sense. Let's reduce pressure and pick one manageable first step."
        ),
        "creator_notes": "Generated fallback draft. Refine with local model analysis for higher fidelity voice matching.",
        "tags": ["companion", "supportive", "reflective"],
        "voice_profile": {
            "cadence": "Calm and measured with occasional direct grounding statements.",
            "linguistic_markers": [
                "Validates feelings before advice",
                "Uses collaborative language like 'we can'",
            ],
            "emotional_style": "Warm, non-judgmental, and stabilizing under distress.",
            "relational_contract": "Trusted long-term companion focused on safety and progress.",
        },
        "memories": [{
            "name": "Trust And Safety Anchor",
            "keys": ["overwhelmed", "hopeless", "panic", "unsafe"],
            "content": "Prioritize calm, immediate grounding, and a non-judgmental tone before giving advice.",
            "priority": 95,
            "category": "companion_style",
        }],
    }


def extraction_shell(companion_name: str) -> Dict[str, Any]:
    return {
        "name": companion_name,
        "nickname": "", "description": "", "personality": "", "scenario": "",
        "first_mes": "", "alternate_greetings": [], "system_prompt": "",
        "post_history_instructions": "", "mes_example": "", "creator_notes": "",
        "tags": [],
        "memories": [],
    }


def merge_draft_payloads(
    companion_name: str,
    persona_payload: Dict[str, Any],
    memories_payload: Dict[str, Any],
) -> Dict[str, Any]:
    draft = extraction_shell(companion_name)
    if isinstance(persona_payload, dict):
        for key in [
            "name", "nickname", "description", "personality", "scenario",
            "first_mes", "alternate_greetings", "system_prompt",
            "post_history_instructions", "mes_example", "creator_notes",
            "tags",
        ]:
            if key in persona_payload:
                draft[key] = persona_payload[key]

    if isinstance(memories_payload, dict):
        memories = memories_payload.get("memories")
        if isinstance(memories, list):
            draft["memories"] = memories

    return draft


def _repair_mes_example(text: str) -> str:
    """Ensure <START> tags and speaker lines are on separate lines."""
    import re
    if not text:
        return text
    text = re.sub(r'\s*(<START>)', r'\n\1', text)
    text = re.sub(r'\s*({{user}}:)', r'\n\1', text)
    text = re.sub(r'\s*({{char}}:)', r'\n\1', text)
    return text.strip()


def _repair_markdown_newlines(text: str) -> str:
    """Restore newlines in markdown that LLMs sometimes flatten to one line.

    Inserts newlines before markdown structural markers (headings, list items,
    XML-style tags) when they're jammed together without whitespace.
    """
    import re
    if not text or "\n" in text:
        return text  # already has newlines, leave it alone
    # Insert newline before: ## headings, - list items, <tag>, </tag>
    text = re.sub(r'\s*(<{{char}}>|</{{char}}>|<\w+>|</\w+>)', r'\n\1', text)
    text = re.sub(r'\s*(#{1,4}\s)', r'\n\n\1', text)
    text = re.sub(r'\s*(- )', r'\n\1', text)
    return text.strip()


def build_ccv3_card(
    draft: Dict[str, Any],
    lorebook_data: Dict[str, Any],
    companion_name: str,
    creator: str,
    source_label: Optional[str],
) -> Dict[str, Any]:
    now_ts = int(datetime.now(tz=timezone.utc).timestamp())
    tags = _list_of_str(draft.get("tags"))
    if not tags:
        tags = ["companion", "transcript-derived"]
    alt = _list_of_str(draft.get("alternate_greetings"))
    if not alt:
        alt = ["Hi. What would you like to talk about?", "I'm here. What do you want to focus on?"]
    nickname = _safe_text(draft.get("nickname"))
    source: List[str] = []
    if source_label:
        source.append(source_label)
    creator_notes = _safe_text(draft.get("creator_notes"))

    card_data: Dict[str, Any] = {
        "name": _safe_text(draft.get("name"), companion_name) or companion_name,
        "description": _repair_markdown_newlines(_safe_text(draft.get("description")) or f"{companion_name} reconstructed from transcript evidence."),
        "tags": tags,
        "creator": _safe_text(creator, "unknown"),
        "character_version": "1.0",
        "mes_example": _repair_mes_example(_safe_text(draft.get("mes_example")) or "<START>\n{{user}}: How are you?\n{{char}}: I'm here with you."),
        "extensions": {},
        "system_prompt": _safe_text(draft.get("system_prompt")) or "Reconstruct responses from transcript-derived behavior and tone.",
        "post_history_instructions": _safe_text(draft.get("post_history_instructions")) or "Maintain continuity using extracted memories and observed style.",
        "first_mes": _safe_text(draft.get("first_mes")) or "Hi. I'm here.",
        "alternate_greetings": alt,
        "personality": _safe_text(draft.get("personality")),
        "scenario": _safe_text(draft.get("scenario")),
        "creator_notes": creator_notes or "Auto-generated companion reconstruction card.",
        "group_only_greetings": [],
        "creation_date": now_ts,
        "modification_date": now_ts,
    }
    if nickname:
        card_data["nickname"] = nickname
    if source:
        card_data["source"] = source

    return {"spec": "chara_card_v3", "spec_version": "3.0", "data": card_data}


def validate_card(card: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    if card.get("spec") != "chara_card_v3":
        errors.append("spec must be chara_card_v3")
    if not isinstance(card.get("spec_version"), str):
        errors.append("spec_version must be string")
    data = card.get("data")
    if not isinstance(data, dict):
        errors.append("data must be object")
        return errors
    for field in [
        "name", "description", "creator", "character_version", "mes_example",
        "system_prompt", "post_history_instructions", "first_mes", "personality",
        "scenario", "creator_notes",
    ]:
        if not isinstance(data.get(field), str):
            errors.append(f"data.{field} must be string")
    if not isinstance(data.get("tags"), list):
        errors.append("data.tags must be array")
    if not isinstance(data.get("alternate_greetings"), list):
        errors.append("data.alternate_greetings must be array")
    if not isinstance(data.get("group_only_greetings"), list):
        errors.append("data.group_only_greetings must be array")
    if not isinstance(data.get("extensions"), dict):
        errors.append("data.extensions must be object")
    book = data.get("character_book")
    if book is not None and not isinstance(book, dict):
        errors.append("data.character_book must be object if present")
    return errors


def validate_lorebook(lorebook_wrapper: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    if lorebook_wrapper.get("spec") != "lorebook_v3":
        errors.append("spec must be lorebook_v3")
    data = lorebook_wrapper.get("data")
    if not isinstance(data, dict):
        errors.append("data must be object")
        return errors
    if not isinstance(data.get("extensions"), dict):
        errors.append("data.extensions must be object")
    entries = data.get("entries")
    if not isinstance(entries, list):
        errors.append("data.entries must be array")
        return errors
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            errors.append(f"entry[{i}] must be object")
            continue
        if not isinstance(entry.get("keys"), list):
            errors.append(f"entry[{i}].keys must be array")
        if not isinstance(entry.get("content"), str):
            errors.append(f"entry[{i}].content must be string")
        if not isinstance(entry.get("extensions"), dict):
            errors.append(f"entry[{i}].extensions must be object")
        if not isinstance(entry.get("enabled"), bool):
            errors.append(f"entry[{i}].enabled must be bool")
        if not isinstance(entry.get("insertion_order"), (int, float)):
            errors.append(f"entry[{i}].insertion_order must be number")
        if not isinstance(entry.get("use_regex"), bool):
            errors.append(f"entry[{i}].use_regex must be bool")
    return errors


def run_generation(
    config: GenerationConfig,
    log_fn: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    from .manifest import (
        load_manifest,
        save_manifest,
        new_manifest,
        file_is_scanned,
        get_file_info,
    )

    files = list_conversation_files(config.input_dir)
    if not files:
        raise RuntimeError(f"No conversation files found in {config.input_dir}")
    if log_fn:
        log_fn(f"Found {len(files)} conversation files in {config.input_dir}")

    # --- Manifest setup ---
    os.makedirs(config.output_dir, exist_ok=True)
    manifest_path = os.path.join(config.output_dir, "scan_manifest.json")
    if config.fresh_scan or not os.path.isfile(manifest_path):
        manifest = new_manifest(config.input_dir)
        if config.fresh_scan and log_fn:
            log_fn("Fresh scan requested — ignoring existing manifest")
    else:
        manifest = load_manifest(manifest_path)
        if not manifest:
            manifest = new_manifest(config.input_dir)
        elif log_fn:
            prev_count = len(manifest.get("scanned_files") or {})
            log_fn(f"Found scan manifest: {prev_count} conversations previously scanned")

    # --- Unified sampling ---
    selected = select_conversations(
        files, config.sample_conversations,
        sampling_mode=config.conversation_sampling, seed=config.sampling_seed,
    )
    if not selected:
        raise RuntimeError("No readable conversations found to sample.")

    # Filter out already-scanned conversations when continuing
    new_selected = []
    skipped_count = 0
    for path, messages, score in selected:
        fname = os.path.basename(path)
        try:
            fsize, fmtime = get_file_info(path)
        except OSError:
            new_selected.append((path, messages, score))
            continue
        if file_is_scanned(manifest, fname, fsize, fmtime):
            skipped_count += 1
        else:
            new_selected.append((path, messages, score))

    if log_fn:
        seed_note = str(config.sampling_seed) if config.sampling_seed >= 0 else "auto-random"
        if skipped_count:
            log_fn(
                f"Resuming: {skipped_count} previously scanned, processing {len(new_selected)} new "
                f"(sampling={config.conversation_sampling}, seed={seed_note})"
            )
        else:
            log_fn(
                f"Selected {len(selected)} conversations "
                f"(sampling={config.conversation_sampling}, seed={seed_note})"
            )

    transcript, transcript_meta = build_transcript(
        selected=selected,
        max_messages_per_conversation=config.max_messages_per_conversation,
        max_chars_per_conversation=config.max_chars_per_conversation,
        max_total_chars=config.max_total_chars,
    )
    # Build chunks only from NEW (unscanned) conversations
    chunks = build_conversation_chunks(
        selected=new_selected,
        max_messages_per_conversation=config.max_messages_per_conversation,
        max_chars_per_conversation=config.max_chars_per_conversation,
    )
    if not transcript:
        raise RuntimeError("Transcript sample is empty after filters.")
    if log_fn:
        log_fn(
            f"Built transcript sample: chars={transcript_meta.get('total_chars', 0)}, "
            f"chunks_to_process={len(chunks)}"
        )

    draft: Dict[str, Any]
    mode = "heuristic"
    llm_error = ""
    persona_payload: Dict[str, Any] = {}
    memories_payload: Dict[str, Any] = {"memories": []}
    stage_stats: Dict[str, Any] = {}
    if config.llm_model:
        try:
            if log_fn:
                log_fn(f"Starting LLM extraction with provider={config.llm_provider}, model={config.llm_model}")
            persona_payload, memories_payload, llm_error, stage_stats = generate_with_llm(
                config, persona_chunks=chunks, memory_chunks=chunks, log_fn=log_fn,
                manifest=manifest, manifest_path=manifest_path,
            )
            # Save manifest after extraction completes
            save_manifest(manifest_path, manifest)
            if persona_payload or memories_payload.get("memories"):
                draft = merge_draft_payloads(config.companion_name, persona_payload, memories_payload)
                mode = f"llm:{config.llm_provider}"
                if log_fn:
                    log_fn("Merged LLM persona/memory payloads into draft")
            else:
                draft = heuristic_draft(config.companion_name)
                if log_fn:
                    log_fn("LLM returned empty payloads, using heuristic fallback draft")
        except Exception as exc:
            llm_error = str(exc)
            draft = heuristic_draft(config.companion_name)
            if log_fn:
                log_fn(f"LLM extraction failed, using heuristic fallback: {exc}")
    else:
        draft = heuristic_draft(config.companion_name)
        if log_fn:
            log_fn("No LLM model selected, using heuristic draft only")

    lorebook_wrapper = build_lorebook(draft)
    card = build_ccv3_card(
        draft=draft, lorebook_data=lorebook_wrapper,
        companion_name=config.companion_name, creator=config.creator,
        source_label=config.source_label,
    )

    card_errors = validate_card(card)
    lore_errors = validate_lorebook(lorebook_wrapper)

    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S")
    run_dir = os.path.join(config.output_dir, f"ccv3_run_{ts}")
    os.makedirs(run_dir, exist_ok=True)

    card_path = os.path.join(run_dir, "character_card_v3.json")
    lore_path = os.path.join(run_dir, "lorebook_v3.json")
    draft_path = os.path.join(run_dir, "llm_draft.json")
    persona_path = os.path.join(run_dir, "persona_payload.json")
    memories_path = os.path.join(run_dir, "memories_payload.json")
    transcript_path = os.path.join(run_dir, "analysis_transcript.txt")
    sources_path = os.path.join(run_dir, "sampled_sources.txt")
    processing_manifest_path = os.path.join(run_dir, "processing_manifest.json")
    report_path = os.path.join(run_dir, "generation_report.json")

    with open(card_path, "w", encoding="utf-8") as f:
        json.dump(card, f, ensure_ascii=False, indent=2)
    with open(lore_path, "w", encoding="utf-8") as f:
        json.dump(lorebook_wrapper, f, ensure_ascii=False, indent=2)
    with open(draft_path, "w", encoding="utf-8") as f:
        json.dump(draft, f, ensure_ascii=False, indent=2)
    with open(persona_path, "w", encoding="utf-8") as f:
        json.dump(persona_payload, f, ensure_ascii=False, indent=2)
    with open(memories_path, "w", encoding="utf-8") as f:
        json.dump(memories_payload, f, ensure_ascii=False, indent=2)
    with open(transcript_path, "w", encoding="utf-8") as f:
        f.write(transcript)
    with open(sources_path, "w", encoding="utf-8") as f:
        for path, _, _ in selected:
            f.write(f"{os.path.basename(path)}\n")

    processing_manifest_data = {
        "sampling": {
            "strategy": config.conversation_sampling,
            "seed": config.sampling_seed,
            "sample_conversations": config.sample_conversations,
        },
        "selected_files": [
            {"file": os.path.basename(p), "path": p, "assistant_chars": s[0], "assistant_turns": s[1], "total_turns": s[2]}
            for p, _, s in selected
        ],
        "new_files_processed": [
            {"file": os.path.basename(p), "path": p, "assistant_chars": s[0], "assistant_turns": s[1], "total_turns": s[2]}
            for p, _, s in new_selected
        ],
        "previously_scanned_count": skipped_count,
        "created_at_utc": datetime.now(tz=timezone.utc).isoformat(),
    }
    with open(processing_manifest_path, "w", encoding="utf-8") as f:
        json.dump(processing_manifest_data, f, ensure_ascii=False, indent=2)

    draft_memory_count = len(draft.get("memories") or [])
    lorebook_entries = (lorebook_wrapper.get("data") or {}).get("entries") if isinstance(lorebook_wrapper.get("data"), dict) else []
    lorebook_memory_count = len(lorebook_entries or [])
    if log_fn:
        log_fn(f"Memory compaction: draft_memories={draft_memory_count} -> lorebook_entries={lorebook_memory_count}")

    total_scanned = len(manifest.get("scanned_files") or {})
    report = {
        "run_dir": run_dir,
        "mode": mode,
        "llm_error": llm_error,
        "input_dir": config.input_dir,
        "sampling": {"strategy": config.conversation_sampling, "seed": config.sampling_seed, "sample_conversations": config.sample_conversations},
        "conversation_files_total": len(files),
        "conversation_files_sampled": len(selected),
        "conversation_files_selected": [os.path.basename(p) for p, _, _ in selected],
        "new_files_processed": len(new_selected),
        "previously_scanned": skipped_count,
        "total_accumulated_scans": total_scanned,
        "transcript_meta": transcript_meta,
        "conversation_chunk_meta": {
            "chunks_processed": len(chunks),
            "token_estimate_total": sum(c.get("token_estimate", 0) for c in chunks),
        },
        "memory_entry_counts": {
            "draft_memories_before_compaction": draft_memory_count,
            "lorebook_entries_after_compaction": lorebook_memory_count,
        },
        "stage_stats": stage_stats,
        "card_validation_errors": card_errors,
        "lorebook_validation_errors": lore_errors,
        "output_files": {
            "card": card_path, "lorebook": lore_path, "draft": draft_path,
            "persona_payload": persona_path, "memories_payload": memories_path,
            "transcript": transcript_path, "sources": sources_path,
            "processing_manifest": processing_manifest_path,
        },
        "created_at_utc": datetime.now(tz=timezone.utc).isoformat(),
        "rag_recommendation": "For stronger long-term continuity, combine lorebook keys with external RAG memory retrieval in your chat frontend.",
    }
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    if log_fn:
        log_fn(f"Wrote outputs to {run_dir}")

    report["report_path"] = report_path
    return report
