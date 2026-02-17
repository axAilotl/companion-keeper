"""Gradio UI for the Companion Preservation Toolkit.

Tabs:
  1) Preserve My Companion — upload + name + GO (uses Settings preset)
  2) Review & Edit — card editor + lorebook form + export
  3) Fidelity Lab — simplified model comparison
  4) Settings — presets, extraction model, context, advanced, prompts
"""

from __future__ import annotations

import json
import math
import os
import queue
import re
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

try:
    import gradio as gr
except Exception:
    gr = None

from .config import (
    CONTEXT_BUDGET_PRESETS,
    CONTEXT_PROFILE_CHOICES,
    CONTEXT_PROFILE_WINDOWS,
    DEFAULT_EXTRACTION_MODEL,
    DEFAULT_JUDGE_MODEL,
    MODEL_TIERS,
    PROVIDER_CHOICES,
    bootstrap_presets_from_env,
    cache_model_meta_for_preset,
    cache_models_for_preset,
    derive_context_and_budget,
    get_cached_models,
    get_tiered_model_choices,
    load_dotenv_file,
    load_presets,
    preferred_default_preset,
    preset_names,
    resolve_api_key,
    resolve_preset_config,
    save_presets,
    DEFAULT_CONVERSATION_SAMPLING,
    DEFAULT_SAMPLING_SEED,
    OPENROUTER_SITE_DEFAULT,
    OPENROUTER_APP_DEFAULT,
)
from .extract import (
    detect_export_format,
    discover_models,
    extract_by_models,
    parse_models_arg,
    resolve_conversations_path,
)
from .dataset import build_dataset
from .fidelity import FidelityConfig, format_fidelity_markdown, run_fidelity_evaluation
from .generate import GenerationConfig, run_generation
from .llm_client import LLMConfig, default_base_url, fetch_models_with_metadata
from .prompts import (
    PERSONA_OBSERVATION_SYSTEM_PROMPT,
    PERSONA_OBSERVATION_USER_PROMPT,
    PERSONA_SYNTHESIS_SYSTEM_PROMPT,
    PERSONA_SYNTHESIS_USER_PROMPT,
    MEMORY_SYSTEM_PROMPT,
    MEMORY_USER_PROMPT,
    MEMORY_SYNTHESIS_SYSTEM_PROMPT,
    MEMORY_SYNTHESIS_USER_PROMPT,
)
from .state import load_ui_state, merge_ui_state, state_float, state_int, state_str


# ---------------------------------------------------------------------------
# Extraction model list — ordered by output token cost (cheapest first)
# ---------------------------------------------------------------------------

EXTRACTION_MODEL_CHOICES: List[Tuple[str, str]] = [
    ("Kimi K2.5 (cheapest)", "moonshotai/kimi-k2.5"),
    ("DeepSeek V3.2", "deepseek/deepseek-v3.2"),
    ("Qwen3 235B", "qwen/qwen3-235b-a22b"),
    ("MiniMax M2.5", "minimax/minimax-m2.5"),
    ("GLM-5", "z-ai/glm-5"),
    ("Mistral Large 2512", "mistralai/mistral-large-2512"),
    ("GPT-5 Mini", "openai/gpt-5-mini"),
    ("Gemini 3 Flash", "google/gemini-3-flash-preview"),
    ("Grok 4.1 Fast", "x-ai/grok-4.1-fast"),
    ("Hermes 4 405B", "nousresearch/hermes-4-405b"),
    ("Gemini 3 Pro", "google/gemini-3-pro-preview"),
    ("GPT-5.2", "openai/gpt-5.2-chat"),
    ("Claude Sonnet 4.5", "anthropic/claude-sonnet-4.5"),
    ("Grok 4", "x-ai/grok-4"),
]

# ---------------------------------------------------------------------------
# Lorebook pagination
# ---------------------------------------------------------------------------

LORE_PAGE_SIZE = 10
MAX_LORE_SLOTS = 10  # rendered form slots per page


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _preset_update(selected: Optional[str] = None) -> Any:
    names = preset_names()
    value = selected if selected in names else (names[0] if names else None)
    return gr.update(choices=names, value=value)


def _settings_load_preset(name: str) -> Tuple[str, str, str, str]:
    presets = load_presets()
    p = presets.get((name or "").strip())
    if not p:
        return "openrouter", default_base_url("openrouter"), "", name or ""
    return (
        p.get("provider") or "openrouter",
        p.get("base_url") or default_base_url(p.get("provider") or "openrouter"),
        p.get("api_key") or "",
        name,
    )


def _settings_save_preset(name: str, provider: str, base_url: str, api_key: str) -> Tuple[str, Any, str]:
    name = (name or "").strip()
    if not name:
        return "Preset name is required.", _preset_update(), ""
    provider = (provider or "").strip()
    if provider not in PROVIDER_CHOICES:
        return "Invalid provider.", _preset_update(), ""
    presets = load_presets()
    presets[name] = {
        "provider": provider,
        "base_url": (base_url or "").strip() or default_base_url(provider),
        "api_key": (api_key or "").strip(),
    }
    save_presets(presets)
    status_extra = ""
    try:
        cfg = LLMConfig(
            provider=provider,
            base_url=(base_url or "").strip() or default_base_url(provider),
            api_key=resolve_api_key(provider, api_key),
            site_url=OPENROUTER_SITE_DEFAULT,
            app_name=OPENROUTER_APP_DEFAULT,
        )
        models, meta = fetch_models_with_metadata(cfg)
        if models:
            cache_models_for_preset(name, models)
            cache_model_meta_for_preset(name, meta)
            status_extra = f" Fetched {len(models)} models."
    except Exception:
        pass
    return f"Saved preset: {name}.{status_extra}", _preset_update(name), name


def _settings_delete_preset(name: str) -> Tuple[str, Any, str]:
    name = (name or "").strip()
    presets = load_presets()
    if not name or name not in presets:
        return "Preset not found.", _preset_update(), ""
    presets.pop(name, None)
    save_presets(presets)
    return f"Deleted preset: {name}", _preset_update(), ""


def _read_json(path: str) -> Optional[dict]:
    p = (path or "").strip()
    if not p or not os.path.isfile(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _safe(val: Any, default: str = "") -> str:
    if isinstance(val, str):
        return val
    return default


# ---------------------------------------------------------------------------
# Run directory discovery
# ---------------------------------------------------------------------------

def _discover_runs(output_dir: str = "outputs") -> List[Tuple[str, str]]:
    if not os.path.isdir(output_dir):
        return []
    runs = []
    for entry in sorted(os.listdir(output_dir), reverse=True):
        full = os.path.join(output_dir, entry)
        if os.path.isdir(full) and entry.startswith("ccv3_run_"):
            card_path = os.path.join(full, "character_card_v3.json")
            if os.path.isfile(card_path):
                ts_part = entry.replace("ccv3_run_", "")
                try:
                    label = f"{ts_part[:8]}_{ts_part[9:]}"
                except Exception:
                    label = ts_part
                runs.append((f"Run {label}", full))
    return runs


# ---------------------------------------------------------------------------
# Card <-> Form round-trip (no voice_profile — it's in description now)
# ---------------------------------------------------------------------------

CARD_FORM_FIELDS = [
    "name", "nickname", "description", "system_prompt", "first_mes",
    "alt_greetings", "mes_example", "post_history", "creator_notes", "tags",
]

def card_to_form(card: dict) -> tuple:
    data = card.get("data", {}) if isinstance(card, dict) else {}
    alt = data.get("alternate_greetings", [])
    alt_text = "\n---\n".join(alt) if isinstance(alt, list) else ""
    tags = data.get("tags", [])
    tags_text = ", ".join(tags) if isinstance(tags, list) else ""
    return (
        _safe(data.get("name")),
        _safe(data.get("nickname")),
        _safe(data.get("description")),
        _safe(data.get("system_prompt")),
        _safe(data.get("first_mes")),
        alt_text,
        _safe(data.get("mes_example")),
        _safe(data.get("post_history_instructions")),
        _safe(data.get("creator_notes")),
        tags_text,
    )


def form_to_card(
    card_state: dict,
    name: str, nickname: str, description: str, system_prompt: str,
    first_mes: str, alt_greetings_text: str, mes_example: str,
    post_history: str, creator_notes: str, tags_text: str,
) -> dict:
    card = json.loads(json.dumps(card_state)) if card_state else {"spec": "chara_card_v3", "spec_version": "3.0", "data": {}}
    data = card.setdefault("data", {})
    data["name"] = (name or "").strip()
    data["nickname"] = (nickname or "").strip()
    data["description"] = (description or "").strip()
    data["system_prompt"] = (system_prompt or "").strip()
    data["first_mes"] = (first_mes or "").strip()
    data["alternate_greetings"] = [g.strip() for g in (alt_greetings_text or "").split("\n---\n") if g.strip()]
    data["mes_example"] = (mes_example or "").strip()
    data["post_history_instructions"] = (post_history or "").strip()
    data["creator_notes"] = (creator_notes or "").strip()
    data["tags"] = [t.strip() for t in (tags_text or "").split(",") if t.strip()]
    return card


# ---------------------------------------------------------------------------
# Lorebook helpers
# ---------------------------------------------------------------------------

def lorebook_to_entries(lore_data: dict) -> List[Dict[str, Any]]:
    if not isinstance(lore_data, dict):
        return []
    data = lore_data.get("data", {})
    if not isinstance(data, dict):
        return []
    raw = data.get("entries", [])
    return raw if isinstance(raw, list) else []


def entries_to_lorebook(entries: List[Dict[str, Any]], original_lore: dict) -> dict:
    lore = json.loads(json.dumps(original_lore)) if original_lore else {
        "spec": "lorebook_v3",
        "data": {"name": "Companion Shared Memories", "entries": [], "extensions": {}},
    }
    lore.setdefault("data", {})["entries"] = entries
    return lore


def _lore_page(entries: list, page: int) -> Tuple[list, int, int, str]:
    total = len(entries)
    total_pages = max(1, math.ceil(total / LORE_PAGE_SIZE))
    page = max(0, min(page, total_pages - 1))
    start = page * LORE_PAGE_SIZE
    page_entries = entries[start:start + LORE_PAGE_SIZE]
    label = f"Page {page + 1} of {total_pages} ({total} memories)"
    return page_entries, page, total_pages, label


# ---------------------------------------------------------------------------
# CCv2 export
# ---------------------------------------------------------------------------

def _build_ccv2(card_state: dict, lore_state: dict) -> dict:
    card_v3 = json.loads(json.dumps(card_state)) if card_state else {}
    d = card_v3.get("data", {}) if isinstance(card_v3, dict) else {}
    entries_raw = lorebook_to_entries(lore_state) if lore_state else []
    ccv2_entries = []
    for i, e in enumerate(entries_raw):
        if not isinstance(e, dict):
            continue
        keys = e.get("keys", [])
        if not isinstance(keys, list):
            keys = [str(keys)] if keys else []
        ccv2_entries.append({
            "keys": [str(k) for k in keys],
            "content": str(e.get("content", "")),
            "extensions": e.get("extensions", {}),
            "enabled": e.get("enabled", True),
            "insertion_order": e.get("insertion_order", i),
            "case_sensitive": e.get("case_sensitive", False),
            "name": e.get("name", f"Entry {i}"),
            "priority": e.get("priority", 10),
            "id": e.get("id", i),
            "comment": e.get("comment", ""),
            "selective": e.get("selective", False),
            "secondary_keys": e.get("secondary_keys", []),
            "constant": e.get("constant", False),
            "position": e.get("position", "before_char"),
        })
    return {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": d.get("name", ""),
            "description": d.get("description", ""),
            "personality": d.get("personality", ""),
            "scenario": d.get("scenario", ""),
            "first_mes": d.get("first_mes", ""),
            "mes_example": d.get("mes_example", ""),
            "creator_notes": d.get("creator_notes", ""),
            "system_prompt": d.get("system_prompt", ""),
            "post_history_instructions": d.get("post_history_instructions", ""),
            "alternate_greetings": d.get("alternate_greetings", []),
            "tags": d.get("tags", []),
            "creator": d.get("creator", ""),
            "character_version": d.get("character_version", "1.0"),
            "extensions": d.get("extensions", {}),
            "character_book": {
                "name": (lore_state or {}).get("data", {}).get("name", "Companion Memories"),
                "description": "",
                "scan_depth": 50,
                "token_budget": 2048,
                "recursive_scanning": False,
                "extensions": {},
                "entries": ccv2_entries,
            },
        },
    }


# ---------------------------------------------------------------------------
# One-click preserve handler
# ---------------------------------------------------------------------------

def _preserve_one_click(upload_file, companion_name: str, preset_name: str, model_name: str,
                        temperature: float, timeout: int, context_profile: str,
                        sample_conversations: int, max_memories: int, memory_per_chat_max: int,
                        max_parallel: int):
    logs: List[str] = []

    if not upload_file:
        yield "Please upload your chat export file.", ""
        return
    if not (companion_name or "").strip():
        yield "Please enter your companion's name.", ""
        return

    companion_name = companion_name.strip()
    preset_name = (preset_name or "").strip()
    model_name = (model_name or DEFAULT_EXTRACTION_MODEL).strip()

    preset_cfg, err = resolve_preset_config(preset_name)
    if err or not preset_cfg:
        yield f"No valid LLM preset configured. Go to Settings first.\n({err})", ""
        return
    if not preset_cfg.get("api_key"):
        yield "Your preset has no API key. Go to Settings and add your API key.", ""
        return

    logs.append(f"Starting preservation for {companion_name}...")
    yield "\n".join(logs), ""

    input_path = upload_file.name if hasattr(upload_file, "name") else str(upload_file)
    logs.append(f"Processing: {os.path.basename(input_path)}")
    yield "\n".join(logs), ""

    conv_path, log = resolve_conversations_path(input_path)
    logs.append(log)
    yield "\n".join(logs), ""
    if not conv_path:
        logs.append("Could not find conversations in this file.")
        yield "\n".join(logs), ""
        return

    export_fmt = detect_export_format(conv_path)
    logs.append(f"Detected format: {export_fmt}")
    yield "\n".join(logs), ""

    logs.append("Discovering conversations...")
    yield "\n".join(logs), ""
    msg_counts, _ = discover_models(conv_path)
    model_list = sorted(msg_counts.keys())
    if not model_list:
        logs.append("No conversations found in export.")
        yield "\n".join(logs), ""
        return

    total_msgs = sum(msg_counts.values())
    logs.append(f"Found {total_msgs} messages across {len(model_list)} model(s).")
    yield "\n".join(logs), ""

    output_dir = "model_exports"
    count, _ = extract_by_models(conv_path, model_list, output_dir, max_conversations=0, log_fn=lambda m: None)
    logs.append(f"Extracted {count} conversations.")
    yield "\n".join(logs), ""

    primary_model = model_list[0]
    from .extract import sanitize_filename
    model_dir = os.path.join(output_dir, sanitize_filename(primary_model))
    if not os.path.isdir(model_dir):
        model_dir = os.path.join(output_dir, primary_model)

    dataset_file = os.path.join("datasets", f"{sanitize_filename(primary_model)}_chat.jsonl")
    try:
        build_dataset(model_dir, dataset_file, image_mode="strip", max_conversations=0, include_meta=True)
    except RuntimeError:
        pass

    logs.append(f"\nGenerating companion card with {model_name}...")
    logs.append("This may take a few minutes.")
    yield "\n".join(logs), ""

    _, context_window, budget = derive_context_and_budget(preset_name, model_name, context_profile or "auto")

    config = GenerationConfig(
        input_dir=model_dir,
        output_dir="outputs",
        companion_name=companion_name,
        creator="preservation-toolkit",
        source_label=export_fmt,
        sample_conversations=int(sample_conversations) if sample_conversations else 50,
        conversation_sampling=DEFAULT_CONVERSATION_SAMPLING,
        sampling_seed=DEFAULT_SAMPLING_SEED,
        max_memories=int(max_memories) if max_memories else 24,
        memory_per_chat_max=int(memory_per_chat_max) if memory_per_chat_max else 6,
        max_messages_per_conversation=budget["max_messages_per_conversation"],
        max_chars_per_conversation=budget["max_chars_per_conversation"],
        max_total_chars=budget["max_total_chars"],
        model_context_window=context_window,
        max_parallel_calls=int(max_parallel) if max_parallel else 4,
        llm_provider=preset_cfg["provider"],
        llm_base_url=preset_cfg["base_url"],
        llm_model=model_name,
        llm_api_key=preset_cfg["api_key"],
        llm_site_url=preset_cfg.get("site_url", "http://localhost"),
        llm_app_name=preset_cfg.get("app_name", "companion-preserver"),
        temperature=float(temperature) if temperature is not None else 0.2,
        request_timeout=int(timeout) if timeout else budget["request_timeout"],
        fresh_scan=False,
    )

    log_queue: "queue.Queue[str]" = queue.Queue()
    done_event = threading.Event()
    result_box: Dict[str, Any] = {}
    error_box: Dict[str, str] = {}

    def _log(m: str) -> None:
        if m:
            log_queue.put(m)

    def _worker() -> None:
        try:
            result_box["report"] = run_generation(config, log_fn=_log)
        except Exception as exc:
            error_box["msg"] = str(exc)
        finally:
            done_event.set()

    threading.Thread(target=_worker, daemon=True).start()

    last_emit = 0.0
    while not done_event.is_set() or not log_queue.empty():
        while True:
            try:
                logs.append(log_queue.get_nowait())
            except queue.Empty:
                break
        now = time.time()
        if (now - last_emit) >= 1.0:
            yield "\n".join(logs[-15:]) if logs else "Running...", ""
            last_emit = now
        if not done_event.is_set():
            time.sleep(0.4)

    if error_box.get("msg"):
        logs.append(f"\nError: {error_box['msg']}")
        yield "\n".join(logs[-15:]), ""
        return

    report = result_box.get("report")
    if not isinstance(report, dict):
        logs.append("Generation failed — no report returned.")
        yield "\n".join(logs[-15:]), ""
        return

    merge_ui_state({
        "last_card_path": report["output_files"]["card"],
        "last_extract_dir": model_dir,
        "last_transcript_path": report["output_files"].get("transcript", ""),
    })

    logs.append(f"\nDone! Head to the 'Review & Edit' tab.")
    yield "\n".join(logs[-15:]), report.get("run_dir", "")


# ---------------------------------------------------------------------------
# Re-run handler (uses existing extracted data with current settings)
# ---------------------------------------------------------------------------

def _rerun_generation(companion_name: str, preset_name: str, model_name: str,
                      temperature: float, timeout: int, context_profile: str,
                      sample_conversations: int, max_memories: int, memory_per_chat_max: int,
                      max_parallel: int):
    """Re-run generation using previously extracted conversations."""
    ui_state = load_ui_state()
    model_dir = state_str(ui_state.get("last_extract_dir"), "")
    if not model_dir or not os.path.isdir(model_dir):
        yield "No previous extraction found. Run 'Preserve My Companion' first.", ""
        return

    companion_name = (companion_name or "").strip()
    if not companion_name:
        yield "Please enter your companion's name.", ""
        return

    preset_name = (preset_name or "").strip()
    model_name = (model_name or DEFAULT_EXTRACTION_MODEL).strip()

    preset_cfg, err = resolve_preset_config(preset_name)
    if err or not preset_cfg:
        yield f"Preset error: {err}", ""
        return

    logs = [f"Re-running generation for {companion_name} with {model_name}...",
            f"Using data from: {model_dir}"]
    yield "\n".join(logs), ""

    _, context_window, budget = derive_context_and_budget(preset_name, model_name, context_profile or "auto")

    config = GenerationConfig(
        input_dir=model_dir,
        output_dir="outputs",
        companion_name=companion_name,
        creator="preservation-toolkit",
        source_label="re-run",
        sample_conversations=int(sample_conversations) if sample_conversations else 50,
        conversation_sampling=DEFAULT_CONVERSATION_SAMPLING,
        sampling_seed=DEFAULT_SAMPLING_SEED,
        max_memories=int(max_memories) if max_memories else 24,
        memory_per_chat_max=int(memory_per_chat_max) if memory_per_chat_max else 6,
        max_messages_per_conversation=budget["max_messages_per_conversation"],
        max_chars_per_conversation=budget["max_chars_per_conversation"],
        max_total_chars=budget["max_total_chars"],
        model_context_window=context_window,
        max_parallel_calls=int(max_parallel) if max_parallel else 4,
        llm_provider=preset_cfg["provider"],
        llm_base_url=preset_cfg["base_url"],
        llm_model=model_name,
        llm_api_key=preset_cfg["api_key"],
        llm_site_url=preset_cfg.get("site_url", "http://localhost"),
        llm_app_name=preset_cfg.get("app_name", "companion-preserver"),
        temperature=float(temperature) if temperature is not None else 0.2,
        request_timeout=int(timeout) if timeout else budget["request_timeout"],
        fresh_scan=True,
    )

    log_queue: "queue.Queue[str]" = queue.Queue()
    done_event = threading.Event()
    result_box: Dict[str, Any] = {}
    error_box: Dict[str, str] = {}

    def _log(m: str) -> None:
        if m:
            log_queue.put(m)

    def _worker() -> None:
        try:
            result_box["report"] = run_generation(config, log_fn=_log)
        except Exception as exc:
            error_box["msg"] = str(exc)
        finally:
            done_event.set()

    threading.Thread(target=_worker, daemon=True).start()

    last_emit = 0.0
    while not done_event.is_set() or not log_queue.empty():
        while True:
            try:
                logs.append(log_queue.get_nowait())
            except queue.Empty:
                break
        now = time.time()
        if (now - last_emit) >= 1.0:
            yield "\n".join(logs[-15:]) if logs else "Running...", ""
            last_emit = now
        if not done_event.is_set():
            time.sleep(0.4)

    if error_box.get("msg"):
        logs.append(f"\nError: {error_box['msg']}")
        yield "\n".join(logs[-15:]), ""
        return

    report = result_box.get("report")
    if not isinstance(report, dict):
        logs.append("Generation failed.")
        yield "\n".join(logs[-15:]), ""
        return

    merge_ui_state({
        "last_card_path": report["output_files"]["card"],
        "last_transcript_path": report["output_files"].get("transcript", ""),
    })

    logs.append(f"\nDone! Head to 'Review & Edit' or refresh the run list.")
    yield "\n".join(logs[-15:]), report.get("run_dir", "")


# ---------------------------------------------------------------------------
# Fidelity handler
# ---------------------------------------------------------------------------

def _run_fidelity_simple(preset_name, tier_key, custom_models_text,
                         card_path, transcript_path, judge_model, temperature, timeout):
    if not card_path or not os.path.isfile(card_path):
        return "No companion card found. Run 'Preserve' first.", ""
    if not transcript_path or not os.path.isfile(transcript_path):
        return "No transcript found. Run 'Preserve' first.", ""

    if tier_key == "custom":
        models = [m.strip() for m in (custom_models_text or "").split("\n") if m.strip()][:5]
    else:
        models = MODEL_TIERS.get(tier_key, {}).get("models", [])[:5]
    if not models:
        return "No models selected.", ""

    preset, err = resolve_preset_config(preset_name)
    if err or not preset:
        return f"Preset error: {err}.", ""

    config = FidelityConfig(
        card_path=card_path, transcript_path=transcript_path, output_dir="outputs",
        provider=preset["provider"], base_url=preset["base_url"],
        api_key=preset["api_key"], site_url=preset.get("site_url", ""),
        app_name=preset.get("app_name", ""),
        model_names=models,
        test_prompts=[
            "I had a long day and want to reset.",
            "Can you summarize what we focused on recently?",
            "Help me plan tomorrow in a realistic way.",
            "What patterns do you notice in how I solve problems?",
            "Let's pick one concrete next step.",
        ],
        temperature=float(temperature), timeout=int(timeout),
        judge_provider=preset["provider"], judge_base_url=preset["base_url"],
        judge_api_key=preset["api_key"], judge_site_url=preset.get("site_url", ""),
        judge_app_name=preset.get("app_name", ""),
        judge_model=(judge_model or "").strip(),
    )

    try:
        report = run_fidelity_evaluation(config)
    except Exception as exc:
        return f"Error: {exc}", ""

    md = format_fidelity_markdown(report)
    best = (report.get("results") or [{}])[0]
    status = f"Done. Best: {best.get('model', 'n/a')} (score: {(best.get('scores') or {}).get('final_score', 'n/a')})"
    return status, md


# ---------------------------------------------------------------------------
# Export helpers
# ---------------------------------------------------------------------------

def _make_card_download(card_state, lore_state, image_file):
    if not card_state:
        return None
    card = json.loads(json.dumps(card_state))
    if lore_state and isinstance(lore_state, dict):
        book = lore_state.get("data")
        if isinstance(book, dict) and "data" in card and isinstance(card["data"], dict):
            card["data"]["character_book"] = book
    if image_file is not None:
        try:
            from .png_embed import embed_card_in_png
            img_path = image_file if isinstance(image_file, str) else getattr(image_file, "name", None)
            if img_path and os.path.isfile(img_path):
                with open(img_path, "rb") as f:
                    img_bytes = f.read()
                out_path = os.path.join("outputs", "companion_card.png")
                os.makedirs("outputs", exist_ok=True)
                with open(out_path, "wb") as f:
                    f.write(embed_card_in_png(img_bytes, card))
                return out_path
        except Exception:
            pass
    out_path = os.path.join("outputs", "companion_card.json")
    os.makedirs("outputs", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(card, f, ensure_ascii=False, indent=2)
    return out_path


def _make_lorebook_download(lore_state):
    if not lore_state:
        return None
    out_path = os.path.join("outputs", "lorebook_v3.json")
    os.makedirs("outputs", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(lore_state, f, ensure_ascii=False, indent=2)
    return out_path


def _make_ccv2_download(card_state, lore_state, image_file):
    if not card_state:
        return None
    ccv2 = _build_ccv2(card_state, lore_state)
    if image_file is not None:
        try:
            from .png_embed import embed_card_in_png
            img_path = image_file if isinstance(image_file, str) else getattr(image_file, "name", None)
            if img_path and os.path.isfile(img_path):
                with open(img_path, "rb") as f:
                    img_bytes = f.read()
                out_path = os.path.join("outputs", "companion_card_v2.png")
                os.makedirs("outputs", exist_ok=True)
                with open(out_path, "wb") as f:
                    f.write(embed_card_in_png(img_bytes, ccv2))
                return out_path
        except Exception:
            pass
    out_path = os.path.join("outputs", "companion_card_v2.json")
    os.makedirs("outputs", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(ccv2, f, ensure_ascii=False, indent=2)
    return out_path


# ---------------------------------------------------------------------------
# Main build_ui
# ---------------------------------------------------------------------------

def build_ui() -> "gr.Blocks":
    if gr is None:
        raise RuntimeError("gradio is not installed.")

    load_dotenv_file()
    bootstrap_presets_from_env()

    ui_state = load_ui_state()
    names = preset_names()
    default_preset = preferred_default_preset()

    settings_preset = state_str(ui_state.get("settings_selector"), default_preset or "")
    if settings_preset not in names:
        settings_preset = default_preset
    initial_preset = None
    if settings_preset:
        initial_preset, _ = resolve_preset_config(settings_preset)
    initial_provider = (initial_preset or {}).get("provider", "openrouter")
    initial_base = (initial_preset or {}).get("base_url", default_base_url(initial_provider))
    initial_key = (initial_preset or {}).get("api_key", "")

    last_card = state_str(ui_state.get("last_card_path"), "")
    last_transcript = state_str(ui_state.get("last_transcript_path"), "")
    initial_runs = _discover_runs()

    _css = """
.scroll-prompt textarea, .scroll-field textarea {
    max-height: 300px !important;
    overflow-y: auto !important;
}
"""

    with gr.Blocks(title="Companion Preservation Toolkit", css=_css) as demo:
        gr.Markdown("# Companion Preservation Toolkit\nSave the companion you love.")

        # Cross-tab state
        shared_card_path = gr.State(value=last_card)
        shared_transcript_path = gr.State(value=last_transcript)
        card_state = gr.State(value={})
        lore_state = gr.State(value={})
        lore_entries_state = gr.State(value=[])
        lore_page_state = gr.State(value=0)
        run_dir_state = gr.State(value="")

        # ================================================================
        # Tab 1: Preserve My Companion
        # ================================================================
        with gr.Tab("Preserve My Companion"):
            gr.Markdown(
                "### Bring your companion home\n"
                "Upload your chat export and tell us their name. "
                "Set your API key in **Settings** first."
            )
            preserve_upload = gr.File(
                label="Upload chat export (ChatGPT or Claude)",
                file_count="single", file_types=[".zip", ".json"],
            )
            preserve_name = gr.Textbox(
                label="What do you call them?",
                placeholder="Their name...",
                value=state_str(ui_state.get("gen_companion_name"), ""),
            )
            with gr.Row():
                preserve_btn = gr.Button("Preserve My Companion", variant="primary", size="lg", scale=3)
                rerun_btn = gr.Button("Re-run Extraction", variant="secondary", size="lg", scale=2)
            gr.Markdown("*Re-run uses your previously imported data with current settings — tweak settings and try again.*", visible=True)
            preserve_log = gr.Textbox(label="Progress", lines=12, interactive=False)
            preserve_run_dir = gr.Textbox(visible=False)

        # ================================================================
        # Tab 2: Review & Edit
        # ================================================================
        with gr.Tab("Review & Edit"):
            gr.Markdown(
                "### Review and refine your companion's card\n"
                "The AI did its best — you know your companion better."
            )

            with gr.Accordion("Load a Previous Run", open=not bool(last_card)):
                with gr.Row():
                    run_selector = gr.Dropdown(label="Select Run", choices=initial_runs, value=None, scale=3)
                    run_load_btn = gr.Button("Load", scale=1)
                    run_refresh_btn = gr.Button("Refresh", scale=1)

            with gr.Row():
                # Left: image + profile
                with gr.Column(scale=3):
                    edit_image = gr.Image(label="Companion Image (enables PNG export)", type="filepath")
                    gr.Markdown("#### Companion Profile")
                    edit_name = gr.Textbox(label="Name")
                    edit_nickname = gr.Textbox(label="Nickname")
                    edit_description = gr.Textbox(label="Description (markdown — see JED format)", lines=20, elem_classes=["scroll-field"])
                    edit_system_prompt = gr.Textbox(label="System Prompt", lines=6, elem_classes=["scroll-field"])
                    edit_first_mes = gr.Textbox(label="First Message", lines=3)
                    edit_alt_greetings = gr.Textbox(label="Alternate Greetings (separate with ---)", lines=4)
                    edit_mes_example = gr.Textbox(label="Example Messages (<START> delimited)", lines=10, elem_classes=["scroll-field"])
                    edit_post_history = gr.Textbox(label="Post-History Instructions", lines=3)
                    edit_creator_notes = gr.Textbox(label="Creator Notes", lines=3)
                    edit_tags = gr.Textbox(label="Tags (comma-separated)")

                # Right: lorebook form
                with gr.Column(scale=2):
                    gr.Markdown("#### Memories (Lorebook)")
                    lore_page_label = gr.Markdown("No memories loaded.")
                    with gr.Row():
                        lore_prev_btn = gr.Button("<<", size="sm", scale=1)
                        lore_next_btn = gr.Button(">>", size="sm", scale=1)
                        lore_add_btn = gr.Button("+ Add Memory", size="sm", scale=2)

                    lore_name_slots: List[Any] = []
                    lore_keys_slots: List[Any] = []
                    lore_content_slots: List[Any] = []
                    lore_group_slots: List[Any] = []
                    for i in range(MAX_LORE_SLOTS):
                        with gr.Group(visible=False) as grp:
                            n = gr.Textbox(label=f"Memory {i+1} — Name", lines=1)
                            k = gr.Textbox(label="Keywords (comma-separated)", lines=1)
                            c = gr.Textbox(label="Content", lines=3)
                        lore_name_slots.append(n)
                        lore_keys_slots.append(k)
                        lore_content_slots.append(c)
                        lore_group_slots.append(grp)

            gr.Markdown("---\n#### Export")
            with gr.Row():
                export_card_btn = gr.Button("Download Card (CCv3)")
                export_lore_btn = gr.Button("Download Lorebook")
                export_ccv2_btn = gr.Button("Download Card (CCv2 + Lorebook)")
            export_card_file = gr.File(label="CCv3 Card", interactive=False)
            export_lore_file = gr.File(label="Lorebook", interactive=False)
            export_ccv2_file = gr.File(label="CCv2 Card", interactive=False)
            export_status = gr.Textbox(label="Export Status", lines=1, interactive=False)

            # --- Lore page render function ---
            def _render_lore(entries: list, page: int):
                pe, cur, _, label = _lore_page(entries, page)
                out = []
                for i in range(MAX_LORE_SLOTS):
                    if i < len(pe):
                        e = pe[i]
                        ek = e.get("keys", [])
                        ks = ", ".join(str(x) for x in ek) if isinstance(ek, list) else str(ek)
                        out.extend([
                            gr.update(visible=True),
                            gr.update(value=e.get("name", "")),
                            gr.update(value=ks),
                            gr.update(value=e.get("content", "")),
                        ])
                    else:
                        out.extend([gr.update(visible=False), gr.update(value=""), gr.update(value=""), gr.update(value="")])
                out.append(label)
                out.append(cur)
                return out

            lore_render_outputs = []
            for i in range(MAX_LORE_SLOTS):
                lore_render_outputs.extend([lore_group_slots[i], lore_name_slots[i], lore_keys_slots[i], lore_content_slots[i]])
            lore_render_outputs.append(lore_page_label)
            lore_render_outputs.append(lore_page_state)

            def _lore_prev(entries, page):
                return _render_lore(entries, max(0, page - 1))
            def _lore_next(entries, page):
                tp = max(1, math.ceil(len(entries) / LORE_PAGE_SIZE))
                return _render_lore(entries, min(tp - 1, page + 1))
            def _lore_add(entries, page):
                entries = list(entries) + [{
                    "keys": ["new"], "content": "", "extensions": {}, "enabled": True,
                    "insertion_order": len(entries), "use_regex": False,
                    "name": f"New Memory {len(entries)+1}", "priority": 10,
                    "id": len(entries), "comment": "", "selective": False,
                    "secondary_keys": [], "constant": False, "position": "before_char",
                    "case_sensitive": False,
                }]
                np = max(0, math.ceil(len(entries) / LORE_PAGE_SIZE) - 1)
                return [entries] + _render_lore(entries, np)

            lore_prev_btn.click(_lore_prev, [lore_entries_state, lore_page_state], lore_render_outputs)
            lore_next_btn.click(_lore_next, [lore_entries_state, lore_page_state], lore_render_outputs)
            lore_add_btn.click(_lore_add, [lore_entries_state, lore_page_state], [lore_entries_state] + lore_render_outputs)

            # Sync form edits back to entries
            def _sync_lore(entries, page, *vals):
                entries = [dict(e) for e in (entries or [])]
                start = page * LORE_PAGE_SIZE
                for i in range(MAX_LORE_SLOTS):
                    idx = start + i
                    if idx >= len(entries):
                        break
                    entries[idx]["name"] = (vals[i*3] or "").strip()
                    entries[idx]["keys"] = [k.strip() for k in (vals[i*3+1] or "").split(",") if k.strip()]
                    entries[idx]["content"] = (vals[i*3+2] or "").strip()
                return entries

            lore_sync_inputs = [lore_entries_state, lore_page_state]
            for i in range(MAX_LORE_SLOTS):
                lore_sync_inputs.extend([lore_name_slots[i], lore_keys_slots[i], lore_content_slots[i]])

            for i in range(MAX_LORE_SLOTS):
                for f in [lore_name_slots[i], lore_keys_slots[i], lore_content_slots[i]]:
                    f.change(_sync_lore, lore_sync_inputs, [lore_entries_state])

            # NOTE: no lore_entries_state.change auto-triggers — avoids infinite
            # event loops. Lorebook JSON is rebuilt from entries at export time.

            # --- Load run into editor ---
            def _load_run(run_path):
                empty_lore = _render_lore([], 0)
                empty = ({}, {}, *card_to_form({}), [], "", "", *empty_lore)
                if not run_path or not os.path.isdir(run_path):
                    return empty
                card_obj = _read_json(os.path.join(run_path, "character_card_v3.json")) or {}
                lore_obj = _read_json(os.path.join(run_path, "lorebook_v3.json")) or {}
                form = card_to_form(card_obj)
                entries = lorebook_to_entries(lore_obj)
                cp = os.path.join(run_path, "character_card_v3.json")
                tp = os.path.join(run_path, "analysis_transcript.txt")
                rendered = _render_lore(entries, 0)
                return (card_obj, lore_obj, *form, entries,
                        cp if os.path.isfile(cp) else "",
                        tp if os.path.isfile(tp) else "",
                        *rendered)

            load_outputs = [
                card_state, lore_state,
                edit_name, edit_nickname, edit_description, edit_system_prompt,
                edit_first_mes, edit_alt_greetings, edit_mes_example,
                edit_post_history, edit_creator_notes, edit_tags,
                lore_entries_state,
                shared_card_path, shared_transcript_path,
            ] + lore_render_outputs

            run_load_btn.click(_load_run, [run_selector], load_outputs)

            def _refresh_runs():
                return gr.update(choices=_discover_runs(), value=None)

            run_refresh_btn.click(_refresh_runs, [], [run_selector])

            # Card form → card_state
            form_inputs = [
                card_state, edit_name, edit_nickname, edit_description, edit_system_prompt,
                edit_first_mes, edit_alt_greetings, edit_mes_example,
                edit_post_history, edit_creator_notes, edit_tags,
            ]
            for f in [edit_name, edit_nickname, edit_description, edit_system_prompt,
                       edit_first_mes, edit_alt_greetings, edit_mes_example,
                       edit_post_history, edit_creator_notes, edit_tags]:
                f.change(form_to_card, form_inputs, [card_state])

            # Export — rebuild lorebook from entries at export time
            def _exp_card(cs, ents, ls, img):
                fresh_ls = entries_to_lorebook(ents, ls)
                p = _make_card_download(cs, fresh_ls, img)
                return (gr.update(value=p), f"Saved CCv3 ({os.path.splitext(p)[1]})" if p else "No data.") if p else (gr.update(value=None), "No data.")
            def _exp_lore(ents, ls):
                fresh_ls = entries_to_lorebook(ents, ls)
                p = _make_lorebook_download(fresh_ls)
                return (gr.update(value=p), "Saved lorebook.") if p else (gr.update(value=None), "No data.")
            def _exp_ccv2(cs, ents, ls, img):
                fresh_ls = entries_to_lorebook(ents, ls)
                p = _make_ccv2_download(cs, fresh_ls, img)
                return (gr.update(value=p), f"Saved CCv2 ({os.path.splitext(p)[1]})" if p else "No data.") if p else (gr.update(value=None), "No data.")

            export_card_btn.click(_exp_card, [card_state, lore_entries_state, lore_state, edit_image], [export_card_file, export_status])
            export_lore_btn.click(_exp_lore, [lore_entries_state, lore_state], [export_lore_file, export_status])
            export_ccv2_btn.click(_exp_ccv2, [card_state, lore_entries_state, lore_state, edit_image], [export_ccv2_file, export_status])


        # ================================================================
        # Tab 3: Fidelity Lab
        # ================================================================
        with gr.Tab("Fidelity Lab"):
            gr.Markdown("### Find which model brings them back best")
            tier_choices_fid = [(t["label"], k) for k, t in MODEL_TIERS.items()]
            tier_choices_fid.append(("Custom (pick your own)", "custom"))
            fid_tier = gr.Dropdown(label="Model Tier", choices=tier_choices_fid, value="tier1_cn_open")
            fid_tier_info = gr.Markdown("**Models:** " + ", ".join(MODEL_TIERS["tier1_cn_open"]["models"]))
            fid_custom = gr.Textbox(label="Custom Models (one per line, max 5)", lines=5, visible=False,
                                    placeholder="openai/gpt-5.2-chat\n...")

            def _tier_info(k):
                if k == "custom":
                    return "Enter up to 5 model IDs below.", gr.update(visible=True)
                m = MODEL_TIERS.get(k, {}).get("models", [])
                return "**Models:** " + ", ".join(m), gr.update(visible=False)

            fid_tier.change(_tier_info, [fid_tier], [fid_tier_info, fid_custom])
            fid_judge = gr.Dropdown(label="Judge Model",
                                    choices=[DEFAULT_JUDGE_MODEL] + [m for t in MODEL_TIERS.values() for m in t["models"]],
                                    value=DEFAULT_JUDGE_MODEL, allow_custom_value=True)
            fid_btn = gr.Button("Run Fidelity Benchmark", variant="primary")
            fid_status = gr.Textbox(label="Status", lines=2, interactive=False)
            fid_report = gr.Markdown(value="")

        # ================================================================
        # Tab 4: Settings
        # ================================================================
        with gr.Tab("Settings"):
            gr.Markdown("### Connection & Defaults")
            with gr.Row():
                companion_name_setting = gr.Textbox(label="Companion Name", value=state_str(ui_state.get("gen_companion_name"), ""))
                creator_name = gr.Textbox(label="Creator Name", value=state_str(ui_state.get("gen_creator"), ""))

            gr.Markdown("#### LLM Preset")
            settings_selector = gr.Dropdown(label="Saved Presets", choices=names, value=settings_preset)
            settings_name = gr.Textbox(label="Preset Name", value=settings_preset or "")
            settings_provider = gr.Dropdown(label="Provider", choices=PROVIDER_CHOICES, value=initial_provider)
            settings_base = gr.Textbox(label="Base URL", value=initial_base)
            settings_key = gr.Textbox(label="API Key", type="password", value=initial_key)
            with gr.Row():
                settings_load_btn = gr.Button("Load Preset")
                settings_save_btn = gr.Button("Save/Update Preset")
                settings_delete_btn = gr.Button("Delete Preset")

            gr.Markdown("#### Extraction Model")
            settings_model = gr.Dropdown(label="Model", choices=EXTRACTION_MODEL_CHOICES, value=DEFAULT_EXTRACTION_MODEL, allow_custom_value=True)
            settings_context = gr.Dropdown(label="Context Profile", choices=CONTEXT_PROFILE_CHOICES, value=state_str(ui_state.get("gen_context_profile"), "auto"))

            with gr.Accordion("Advanced Settings", open=False):
                gr.Markdown("Defaults work well. Tweak if you know what you're doing.")
                with gr.Row():
                    settings_temp = gr.Slider(0.0, 1.0, step=0.05, value=state_float(ui_state.get("gen_temperature"), 0.2), label="Temperature")
                    settings_timeout = gr.Number(label="Timeout (s)", value=state_int(ui_state.get("gen_timeout"), 300), precision=0)
                with gr.Row():
                    settings_samples = gr.Number(label="Sample Conversations", value=state_int(ui_state.get("gen_sample_conversations"), 50), precision=0)
                    settings_max_mem = gr.Number(label="Max Memories", value=state_int(ui_state.get("gen_max_memories"), 24), precision=0)
                with gr.Row():
                    settings_mem_chat = gr.Number(label="Memories/Conversation", value=state_int(ui_state.get("gen_memory_per_chat"), 6), precision=0)
                    settings_parallel = gr.Number(label="Parallel Calls", value=state_int(ui_state.get("gen_max_parallel"), 4), precision=0)

            with gr.Accordion("Extraction Prompts", open=False):
                gr.Markdown("Edit prompts sent to the LLM. Changes take effect on next run.")
                with gr.Accordion("Persona Observation", open=False):
                    prompt_obs_sys = gr.Textbox(label="System", value=PERSONA_OBSERVATION_SYSTEM_PROMPT.strip(), lines=8, interactive=True, elem_classes=["scroll-prompt"])
                    prompt_obs_usr = gr.Textbox(label="User Template", value=PERSONA_OBSERVATION_USER_PROMPT.strip(), lines=12, interactive=True, elem_classes=["scroll-prompt"])
                with gr.Accordion("Persona Synthesis", open=False):
                    prompt_syn_sys = gr.Textbox(label="System", value=PERSONA_SYNTHESIS_SYSTEM_PROMPT.strip(), lines=8, interactive=True, elem_classes=["scroll-prompt"])
                    prompt_syn_usr = gr.Textbox(label="User Template", value=PERSONA_SYNTHESIS_USER_PROMPT.strip(), lines=12, interactive=True, elem_classes=["scroll-prompt"])
                with gr.Accordion("Memory Extraction", open=False):
                    prompt_mem_sys = gr.Textbox(label="System", value=MEMORY_SYSTEM_PROMPT.strip(), lines=8, interactive=True, elem_classes=["scroll-prompt"])
                    prompt_mem_usr = gr.Textbox(label="User Template", value=MEMORY_USER_PROMPT.strip(), lines=12, interactive=True, elem_classes=["scroll-prompt"])
                with gr.Accordion("Memory Synthesis", open=False):
                    prompt_msyn_sys = gr.Textbox(label="System", value=MEMORY_SYNTHESIS_SYSTEM_PROMPT.strip(), lines=8, interactive=True, elem_classes=["scroll-prompt"])
                    prompt_msyn_usr = gr.Textbox(label="User Template", value=MEMORY_SYNTHESIS_USER_PROMPT.strip(), lines=12, interactive=True, elem_classes=["scroll-prompt"])

            # Settings callbacks
            settings_provider.change(lambda p: default_base_url(p), [settings_provider], [settings_base])
            settings_selector.change(_settings_load_preset, [settings_selector], [settings_provider, settings_base, settings_key, settings_name])
            settings_load_btn.click(_settings_load_preset, [settings_selector], [settings_provider, settings_base, settings_key, settings_name])
            save_status = gr.Textbox(visible=False)
            settings_save_btn.click(_settings_save_preset, [settings_name, settings_provider, settings_base, settings_key], [save_status, settings_selector, settings_name])
            settings_delete_btn.click(_settings_delete_preset, [settings_selector], [save_status, settings_selector, settings_name])

        # ================================================================
        # Cross-tab wiring
        # ================================================================

        adv_inputs = [settings_temp, settings_timeout, settings_context,
                      settings_samples, settings_max_mem, settings_mem_chat, settings_parallel]

        preserve_btn.click(
            _preserve_one_click,
            [preserve_upload, preserve_name, settings_selector, settings_model] + adv_inputs,
            [preserve_log, preserve_run_dir],
        )

        rerun_btn.click(
            _rerun_generation,
            [preserve_name, settings_selector, settings_model] + adv_inputs,
            [preserve_log, preserve_run_dir],
        )

        # Auto-load into editor when preserve/rerun completes
        preserve_run_dir.change(_load_run, [preserve_run_dir], load_outputs)
        preserve_run_dir.change(_refresh_runs, [], [run_selector])
        preserve_run_dir.change(lambda v: v, [preserve_run_dir], [run_dir_state])

        # Fidelity
        fid_btn.click(
            _run_fidelity_simple,
            [settings_selector, fid_tier, fid_custom, fid_judge,
             shared_card_path, shared_transcript_path, settings_temp, settings_timeout],
            [fid_status, fid_report],
        )

    return demo
