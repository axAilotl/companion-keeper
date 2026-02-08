"""New 4-tab Gradio UI for the Companion Preservation Toolkit.

Tabs:
  1) Settings — companion name, creator, LLM preset/provider/model, context profile
  2) Import & Build Dataset — one-shot unzip+extract+build
  3) Generate Character Card — CCv3 + lorebook generation
  4) Fidelity Lab — model fidelity benchmarking
"""

from __future__ import annotations

import json
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
    PROVIDER_CHOICES,
    bootstrap_presets_from_env,
    cache_model_meta_for_preset,
    cache_models_for_preset,
    derive_context_and_budget,
    get_cached_models,
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


def _preset_update(selected: Optional[str] = None) -> Any:
    names = preset_names()
    value = selected if selected in names else (names[0] if names else None)
    return gr.update(choices=names, value=value)


def _settings_load_preset(name: str) -> Tuple[str, str, str, str, str]:
    presets = load_presets()
    p = presets.get((name or "").strip())
    if not p:
        return "openrouter", default_base_url("openrouter"), "", "", "Preset not found."
    return (
        p.get("provider") or "openrouter",
        p.get("base_url") or default_base_url(p.get("provider") or "openrouter"),
        p.get("api_key") or "",
        name,
        f"Loaded preset: {name}",
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
    return f"Saved preset: {name}", _preset_update(name), name


def _settings_delete_preset(name: str) -> Tuple[str, Any, str]:
    name = (name or "").strip()
    presets = load_presets()
    if not name or name not in presets:
        return "Preset not found.", _preset_update(), ""
    presets.pop(name, None)
    save_presets(presets)
    return f"Deleted preset: {name}", _preset_update(), ""


def _fetch_models_for_preset(name: str, provider: str, base_url: str, api_key: str) -> Tuple[str, Any]:
    try:
        cfg = LLMConfig(
            provider=provider,
            base_url=base_url,
            api_key=resolve_api_key(provider, api_key),
            site_url=OPENROUTER_SITE_DEFAULT,
            app_name=OPENROUTER_APP_DEFAULT,
        )
        models, meta = fetch_models_with_metadata(cfg)
    except Exception as exc:
        return f"Model fetch failed:\n{exc}", gr.update(choices=[], value=None)
    if not models:
        return "No models returned.", gr.update(choices=[], value=None)
    cache_models_for_preset(name, models)
    cache_model_meta_for_preset(name, meta)
    return (
        f"Loaded {len(models)} models ({len(meta)} with context window metadata).",
        gr.update(choices=models, value=models[0]),
    )


def _load_models_cached(preset_name: str) -> Tuple[str, Any]:
    cached = get_cached_models(preset_name)
    if cached:
        return f"Loaded {len(cached)} models from cache.", gr.update(choices=cached, value=cached[0])
    resolved, err = resolve_preset_config(preset_name)
    if err or not resolved:
        return f"Model load failed:\n{err}", gr.update(choices=[], value=None)
    try:
        cfg = LLMConfig(
            provider=resolved["provider"],
            base_url=resolved["base_url"],
            api_key=resolved["api_key"],
            site_url=resolved.get("site_url", ""),
            app_name=resolved.get("app_name", ""),
        )
        models, meta = fetch_models_with_metadata(cfg)
    except Exception as exc:
        return f"Model fetch failed:\n{exc}", gr.update(choices=[], value=None)
    cache_models_for_preset(preset_name, models)
    cache_model_meta_for_preset(preset_name, meta)
    if not models:
        return "No models returned.", gr.update(choices=[], value=None)
    return f"Loaded {len(models)} models.", gr.update(choices=models, value=models[0])


def _load_models_multi(preset_name: str) -> Tuple[str, Any]:
    cached = get_cached_models(preset_name)
    if cached:
        return f"Loaded {len(cached)} models from cache.", gr.update(choices=cached, value=[])
    status, update = _load_models_cached(preset_name)
    if isinstance(update, dict):
        choices = update.get("choices") or []
        return status, gr.update(choices=choices, value=[])
    return status, gr.update(choices=[], value=[])


def _budget_defaults(preset_name: str, model_name: str, context_profile: str) -> Tuple[str, int, int, int, int, int]:
    source, context_window, budget = derive_context_and_budget(preset_name, model_name, context_profile)
    status = (
        f"Context preset: {context_profile} | effective_window={context_window} tokens | source={source}\n"
        f"Auto budget: max_msgs={budget['max_messages_per_conversation']}, "
        f"max_chars_per_convo={budget['max_chars_per_conversation']}, "
        f"max_total_chars={budget['max_total_chars']}, timeout={budget['request_timeout']}s"
    )
    return (
        status, context_window,
        int(budget["max_messages_per_conversation"]),
        int(budget["max_chars_per_conversation"]),
        int(budget["max_total_chars"]),
        int(budget["request_timeout"]),
    )


def _read_json_pretty(path: str) -> str:
    p = (path or "").strip()
    if not p or not os.path.isfile(p):
        return ""
    try:
        with open(p, "r", encoding="utf-8") as f:
            obj = json.load(f)
        return json.dumps(obj, ensure_ascii=False, indent=2)
    except Exception:
        return ""


def _save_json_text(path: str, json_text: str, label: str) -> str:
    p = (path or "").strip()
    if not p:
        return f"{label}: path is empty."
    if not json_text.strip():
        return f"{label}: JSON text is empty."
    try:
        obj = json.loads(json_text)
    except Exception as exc:
        return f"{label}: invalid JSON: {exc}"
    try:
        with open(p, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
    except Exception as exc:
        return f"{label}: failed to write: {exc}"
    return f"{label}: saved to {p}"


# --- Import & Build tab handler ---

def _import_and_build(
    input_path: str, models_text: str, companion_name: str,
    max_conversations: int, image_mode: str,
):
    """Generator that yields progress logs for the Import & Build tab."""
    logs: List[str] = []
    started = time.time()

    logs.append(f"[1/3] Resolving input: {input_path}")
    yield "\n".join(logs), "", ""

    conv_path, log = resolve_conversations_path(input_path)
    logs.append(log)
    yield "\n".join(logs), "", ""

    if not conv_path:
        logs.append("Failed to resolve conversations path.")
        yield "\n".join(logs), "", ""
        return

    export_fmt = detect_export_format(conv_path)
    logs.append(f"Detected export format: {export_fmt}")
    yield "\n".join(logs), "", ""

    models_arg = (models_text or "all").strip()
    if models_arg.lower() == "all":
        logs.append("Discovering models...")
        yield "\n".join(logs), "", ""
        msg_counts, _ = discover_models(conv_path)
        model_list = sorted(msg_counts.keys())
        if export_fmt == "anthropic":
            total = msg_counts.get("claude", 0)
            logs.append(f"Anthropic export: {total} messages across all conversations (model: claude)")
        else:
            logs.append(f"Found models: {', '.join(model_list)}")
    else:
        model_list = parse_models_arg(models_arg)

    if not model_list:
        logs.append("No models found or specified.")
        yield "\n".join(logs), "", ""
        return

    output_dir = "model_exports"
    logs.append(f"\n[2/3] Extracting conversations for: {', '.join(model_list)}")
    yield "\n".join(logs), "", ""

    count, _ = extract_by_models(
        conv_path, model_list, output_dir,
        max_conversations=int(max_conversations) if max_conversations else 0,
        log_fn=lambda m: None,
    )
    logs.append(f"Extracted {count} conversations to {output_dir}")
    yield "\n".join(logs), "", ""

    primary_model = model_list[0]
    from .extract import sanitize_filename
    model_dir = os.path.join(output_dir, sanitize_filename(primary_model))
    if not os.path.isdir(model_dir):
        model_dir = os.path.join(output_dir, primary_model)

    dataset_file = os.path.join("datasets", f"{sanitize_filename(primary_model)}_chat.jsonl")
    logs.append(f"\n[3/3] Building dataset from {model_dir}")
    yield "\n".join(logs), "", ""

    try:
        total, kept, skipped = build_dataset(
            model_dir, dataset_file,
            image_mode=image_mode or "strip",
            max_conversations=int(max_conversations) if max_conversations else 0,
            include_meta=True,
        )
        logs.append(f"Dataset: total={total} kept={kept} skipped={skipped}")
    except RuntimeError as exc:
        logs.append(f"Dataset error: {exc}")
        yield "\n".join(logs), "", ""
        return

    elapsed = round(time.time() - started, 2)
    logs.append(f"\nDone in {elapsed}s.")
    logs.append(f"Extracted dir: {model_dir}")
    logs.append(f"Dataset: {dataset_file}")

    # Save state for auto-population
    merge_ui_state({
        "last_extract_dir": model_dir,
        "last_dataset_file": dataset_file,
    })

    yield "\n".join(logs), model_dir, dataset_file


# --- Generate tab handler ---

def _generate_stream(
    input_dir: str, output_dir: str, companion_name: str, creator: str,
    source_label: str, sample_conversations: int, max_memories: int,
    context_profile: str, context_window: int,
    max_msgs: int, max_chars_per: int, max_chars_total: int,
    fresh_scan: bool, preset_name: str, model: str,
    temperature: float, timeout: int,
    p_obs_sys: str, p_obs_usr: str,
    p_syn_sys: str, p_syn_usr: str,
    p_mem_sys: str, p_mem_usr: str,
    p_msyn_sys: str, p_msyn_usr: str,
):
    logs: List[str] = []
    started_at = time.time()
    logs.append("Preparing generation run...")
    yield "\n".join(logs), "", "", "", "", "", ""

    # Save state
    merge_ui_state({
        "gen_input_dir": (input_dir or "").strip(),
        "gen_output_dir": (output_dir or "").strip(),
        "gen_companion_name": (companion_name or "").strip(),
        "gen_creator": (creator or "").strip(),
        "gen_source_label": (source_label or "").strip(),
        "gen_preset": (preset_name or "").strip(),
        "gen_model": (model or "").strip(),
        "gen_context_profile": (context_profile or "auto").strip(),
    })

    in_dir = (input_dir or "").strip()
    out_dir = (output_dir or "outputs").strip()
    if not os.path.isdir(in_dir):
        yield f"Error: input dir not found: {in_dir}", "", "", "", "", "", ""
        return

    preset, err = resolve_preset_config(preset_name)
    if err and (model or "").strip():
        yield f"Error: {err}", "", "", "", "", "", ""
        return

    try:
        cw = int(context_window)
    except (TypeError, ValueError):
        cw = 0

    # Build prompt overrides — only include non-empty custom values
    prompt_overrides = {}
    for key, val in [
        ("persona_observation_system", p_obs_sys),
        ("persona_observation_user", p_obs_usr),
        ("persona_synthesis_system", p_syn_sys),
        ("persona_synthesis_user", p_syn_usr),
        ("memory_system", p_mem_sys),
        ("memory_user", p_mem_usr),
        ("memory_synthesis_system", p_msyn_sys),
        ("memory_synthesis_user", p_msyn_usr),
    ]:
        if (val or "").strip():
            prompt_overrides[key] = val.strip()

    try:
        config = GenerationConfig(
            input_dir=in_dir,
            output_dir=out_dir,
            companion_name=(companion_name or "Companion").strip(),
            creator=(creator or "unknown").strip(),
            source_label=(source_label or "").strip() or None,
            sample_conversations=int(sample_conversations),
            conversation_sampling=DEFAULT_CONVERSATION_SAMPLING,
            sampling_seed=DEFAULT_SAMPLING_SEED,
            max_memories=int(max_memories),
            memory_per_chat_max=min(12, max(3, int(max_memories) // 2 if int(max_memories) > 0 else 6)),
            max_messages_per_conversation=int(max_msgs),
            max_chars_per_conversation=int(max_chars_per),
            max_total_chars=int(max_chars_total),
            model_context_window=cw,
            max_parallel_calls=4,
            llm_provider=(preset or {}).get("provider", "openrouter"),
            llm_base_url=(preset or {}).get("base_url", ""),
            llm_model=(model or "").strip(),
            llm_api_key=(preset or {}).get("api_key", ""),
            llm_site_url=(preset or {}).get("site_url", "http://localhost"),
            llm_app_name=(preset or {}).get("app_name", "companion-preserver"),
            temperature=float(temperature),
            request_timeout=int(timeout),
            fresh_scan=bool(fresh_scan),
            prompt_overrides=prompt_overrides if prompt_overrides else None,
        )
    except Exception as exc:
        yield f"Error building config:\n{exc}", "", "", "", "", "", ""
        return

    log_queue: "queue.Queue[str]" = queue.Queue()
    done_event = threading.Event()
    worker_result: Dict[str, Any] = {}
    worker_error: Dict[str, str] = {}

    def _log(message: str) -> None:
        if message:
            log_queue.put(message)

    def _worker() -> None:
        try:
            worker_result["report"] = run_generation(config, log_fn=_log)
        except Exception as exc:
            worker_error["message"] = str(exc)
        finally:
            done_event.set()

    t = threading.Thread(target=_worker, daemon=True)
    t.start()

    last_emit = 0.0
    while not done_event.is_set() or not log_queue.empty():
        consumed = False
        while True:
            try:
                msg = log_queue.get_nowait()
            except queue.Empty:
                break
            consumed = True
            logs.append(msg)
        now = time.time()
        if consumed or (now - last_emit) >= 1.0:
            status = "\n".join(logs[-80:]) if logs else "Running..."
            yield status, "", "", "", "", "", ""
            last_emit = now
        if not done_event.is_set():
            time.sleep(0.4)

    if worker_error.get("message"):
        status = "Error:\n" + worker_error["message"]
        if logs:
            status += "\n\nRecent logs:\n" + "\n".join(logs[-40:])
        yield status, "", "", "", "", "", ""
        return

    report = worker_result.get("report")
    if not isinstance(report, dict):
        yield "Error: generation did not return a valid report.", "", "", "", "", "", ""
        return

    report_text = json.dumps(report, ensure_ascii=False, indent=2)
    card_path = report["output_files"]["card"]
    lore_path = report["output_files"]["lorebook"]
    card_json_text = _read_json_pretty(card_path)
    lore_json_text = _read_json_pretty(lore_path)
    transcript_path = report["output_files"].get("transcript", "")

    elapsed = round(time.time() - started_at, 2)
    sampling = report.get("sampling") or {}
    memory_counts = report.get("memory_entry_counts") or {}
    summary = (
        f"Generation completed in {elapsed}s.\n"
        f"mode: {report.get('mode')}\n"
        f"sampling: {sampling.get('strategy', 'n/a')}\n"
        f"sampled: {report.get('conversation_files_sampled')}\n"
        f"new_processed: {report.get('new_files_processed')}\n"
        f"previously_scanned: {report.get('previously_scanned')}\n"
        f"total_accumulated: {report.get('total_accumulated_scans')}\n"
        f"memory_compaction: {memory_counts.get('draft_memories_before_compaction', 'n/a')} -> "
        f"{memory_counts.get('lorebook_entries_after_compaction', 'n/a')}\n"
        f"run_dir: {report.get('run_dir')}"
    )
    if logs:
        summary += "\n\nRecent logs:\n" + "\n".join(logs[-30:])

    # Save for cross-tab auto-population
    merge_ui_state({
        "last_card_path": card_path,
        "last_transcript_path": transcript_path,
    })

    yield summary, report_text, card_path, lore_path, "", card_json_text, lore_json_text


# --- Fidelity Lab handler ---

def _run_fidelity(
    card_path: str, transcript_path: str, output_dir: str,
    preset_name: str, candidate_models: Any,
    test_prompts_text: str, temperature: float, timeout: int,
    judge_preset_name: str, judge_model: str,
) -> Tuple[str, str, str, str]:
    if not os.path.isfile(card_path):
        return f"Error: card file not found: {card_path}", "", "", ""
    if not os.path.isfile(transcript_path):
        return f"Error: transcript not found: {transcript_path}", "", "", ""

    if isinstance(candidate_models, list):
        models = [str(m).strip() for m in candidate_models if str(m).strip()][:5]
    else:
        models = [m.strip() for m in re.split(r"[,\n]+", str(candidate_models or "")) if m.strip()][:5]
    prompts = [p.strip() for p in (test_prompts_text or "").splitlines() if p.strip()]

    preset, err = resolve_preset_config(preset_name)
    if err or not preset:
        return f"Error: {err}", "", "", ""

    judge_provider = ""
    judge_base_url = ""
    judge_api_key = ""
    judge_site_url = ""
    judge_app_name = ""
    if (judge_model or "").strip():
        judge_preset, judge_err = resolve_preset_config(judge_preset_name)
        if judge_err or not judge_preset:
            return f"Judge preset error: {judge_err}", "", "", ""
        judge_provider = judge_preset["provider"]
        judge_base_url = judge_preset["base_url"]
        judge_api_key = judge_preset["api_key"]
        judge_site_url = judge_preset["site_url"]
        judge_app_name = judge_preset["app_name"]

    config = FidelityConfig(
        card_path=card_path,
        transcript_path=transcript_path,
        output_dir=(output_dir or "outputs").strip(),
        provider=preset["provider"],
        base_url=preset["base_url"],
        api_key=preset["api_key"],
        site_url=preset["site_url"],
        app_name=preset["app_name"],
        model_names=models,
        test_prompts=prompts,
        temperature=float(temperature),
        timeout=int(timeout),
        judge_provider=judge_provider,
        judge_base_url=judge_base_url,
        judge_api_key=judge_api_key,
        judge_site_url=judge_site_url,
        judge_app_name=judge_app_name,
        judge_model=(judge_model or "").strip(),
    )

    try:
        report = run_fidelity_evaluation(config)
    except Exception as exc:
        return f"Error: {exc}", "", "", ""

    md_summary = format_fidelity_markdown(report)
    best = (report.get("results") or [{}])[0]
    status = (
        f"Fidelity benchmark complete.\n"
        f"models_tested: {len(report.get('results') or [])}\n"
        f"best_model: {best.get('model', 'n/a')}\n"
        f"best_score: {(best.get('scores') or {}).get('final_score', 'n/a')}\n"
        f"report: {report.get('report_path')}"
    )
    return status, md_summary, json.dumps(report, ensure_ascii=False, indent=2), report.get("report_path", "")


def build_ui() -> "gr.Blocks":
    if gr is None:
        raise RuntimeError("gradio is not installed. Install with: pip install gradio>=5.0.0")

    load_dotenv_file()
    bootstrap_presets_from_env()

    ui_state = load_ui_state()
    names = preset_names()
    default_preset = preferred_default_preset()

    # Resolve initial settings
    settings_preset = state_str(ui_state.get("settings_selector"), default_preset or "")
    if settings_preset not in names:
        settings_preset = default_preset
    initial_preset = None
    if settings_preset:
        initial_preset, _ = resolve_preset_config(settings_preset)
    initial_provider = (initial_preset or {}).get("provider", "openrouter")
    initial_base = (initial_preset or {}).get("base_url", default_base_url(initial_provider))
    initial_key = (initial_preset or {}).get("api_key", "")
    initial_models = get_cached_models(settings_preset or "")
    initial_model = initial_models[0] if initial_models else None

    # Generation defaults
    gen_preset = state_str(ui_state.get("gen_preset"), default_preset or "")
    if gen_preset not in names:
        gen_preset = default_preset
    gen_model = state_str(ui_state.get("gen_model"), initial_model or "")
    gen_profile = state_str(ui_state.get("gen_context_profile"), "auto")

    _, init_cw, init_msgs, init_chars, init_total, init_timeout = _budget_defaults(
        gen_preset or "", gen_model, gen_profile,
    )

    # Auto-populated paths from previous runs
    last_extract_dir = state_str(ui_state.get("last_extract_dir"), "model_exports/gpt-4o")
    last_card = state_str(ui_state.get("last_card_path"), "")
    last_transcript = state_str(ui_state.get("last_transcript_path"), "")

    with gr.Blocks(title="Companion Preservation Toolkit") as demo:
        gr.Markdown("# Companion Preservation Toolkit\nSimplified 4-tab workflow.")

        # Cross-tab state
        shared_extract_dir = gr.State(value=last_extract_dir)
        shared_card_path = gr.State(value=last_card)
        shared_transcript_path = gr.State(value=last_transcript)

        # ---- Tab 1: Settings ----
        with gr.Tab("Settings"):
            gr.Markdown("Configure your companion info and LLM connection once.")
            with gr.Row():
                companion_name = gr.Textbox(
                    label="Companion Name",
                    value=state_str(ui_state.get("gen_companion_name"), ""),
                )
                creator_name = gr.Textbox(
                    label="Creator Name",
                    value=state_str(ui_state.get("gen_creator"), ""),
                )

            gr.Markdown("### LLM Preset")
            settings_selector = gr.Dropdown(label="Saved Presets", choices=names, value=settings_preset)
            settings_name = gr.Textbox(label="Preset Name", value=settings_preset or "")
            settings_provider = gr.Dropdown(label="Provider", choices=PROVIDER_CHOICES, value=initial_provider)
            settings_base = gr.Textbox(label="Base URL", value=initial_base)
            settings_key = gr.Textbox(label="API Key", type="password", value=initial_key)
            with gr.Row():
                settings_model = gr.Dropdown(
                    label="Model", choices=initial_models, value=initial_model,
                    allow_custom_value=True, scale=3,
                )
                settings_fetch_btn = gr.Button("Fetch Models", scale=1)

            with gr.Row():
                settings_load_btn = gr.Button("Load Preset")
                settings_save_btn = gr.Button("Save/Update Preset")
                settings_delete_btn = gr.Button("Delete Preset")

            settings_context_profile = gr.Dropdown(
                label="Context Profile",
                choices=CONTEXT_PROFILE_CHOICES,
                value=gen_profile,
            )

            with gr.Accordion("Extraction Prompts (editable)", open=False):
                gr.Markdown("Customize the prompts sent to the LLM during extraction. Use `{{user}}` and `{{char}}` placeholders. Leave blank to use defaults.")
                with gr.Accordion("Persona Observation (per-conversation)", open=False):
                    prompt_obs_sys = gr.Textbox(label="System", value=PERSONA_OBSERVATION_SYSTEM_PROMPT.strip(), lines=8)
                    prompt_obs_usr = gr.Textbox(label="User Template", value=PERSONA_OBSERVATION_USER_PROMPT.strip(), lines=12)
                with gr.Accordion("Persona Synthesis (final merge)", open=False):
                    prompt_syn_sys = gr.Textbox(label="System", value=PERSONA_SYNTHESIS_SYSTEM_PROMPT.strip(), lines=8)
                    prompt_syn_usr = gr.Textbox(label="User Template", value=PERSONA_SYNTHESIS_USER_PROMPT.strip(), lines=16)
                with gr.Accordion("Memory Extraction (per-conversation)", open=False):
                    prompt_mem_sys = gr.Textbox(label="System", value=MEMORY_SYSTEM_PROMPT.strip(), lines=8)
                    prompt_mem_usr = gr.Textbox(label="User Template", value=MEMORY_USER_PROMPT.strip(), lines=12)
                with gr.Accordion("Memory Synthesis (final merge)", open=False):
                    prompt_msyn_sys = gr.Textbox(label="System", value=MEMORY_SYNTHESIS_SYSTEM_PROMPT.strip(), lines=8)
                    prompt_msyn_usr = gr.Textbox(label="User Template", value=MEMORY_SYNTHESIS_USER_PROMPT.strip(), lines=10)

            settings_status = gr.Textbox(label="Status", lines=4)

            # Callbacks
            settings_provider.change(
                lambda p: default_base_url(p), [settings_provider], [settings_base],
            )
            settings_selector.change(
                _settings_load_preset, [settings_selector],
                [settings_provider, settings_base, settings_key, settings_name, settings_status],
            )
            settings_load_btn.click(
                _settings_load_preset, [settings_selector],
                [settings_provider, settings_base, settings_key, settings_name, settings_status],
            )
            settings_save_btn.click(
                _settings_save_preset,
                [settings_name, settings_provider, settings_base, settings_key],
                [settings_status, settings_selector, settings_name],
            )
            settings_delete_btn.click(
                _settings_delete_preset, [settings_selector],
                [settings_status, settings_selector, settings_name],
            )
            settings_fetch_btn.click(
                _fetch_models_for_preset,
                [settings_selector, settings_provider, settings_base, settings_key],
                [settings_status, settings_model],
            )

        # ---- Tab 2: Import & Build Dataset ----
        with gr.Tab("Import & Build Dataset"):
            gr.Markdown(
                "One button: unzip (if ZIP), extract by model, build dataset.\n"
                "Accepts OpenAI or Anthropic `.zip` exports or `conversations.json` directly."
            )
            import_upload = gr.File(
                label="Upload Export (ZIP or JSON)",
                file_count="single",
                file_types=[".zip", ".json"],
            )
            import_input = gr.Textbox(
                label="Input (ZIP or conversations.json)",
                value=state_str(ui_state.get("fp_conv_path"), ""),
            )
            import_upload.change(
                lambda f: f.name if f else "",
                [import_upload], [import_input],
            )
            import_models = gr.Textbox(
                label="Model filter (comma-separated, or 'all')",
                value="all",
            )
            with gr.Accordion("Advanced", open=False):
                import_max = gr.Number(label="Max Conversations (0 = no limit)", value=0, precision=0)
                import_image_mode = gr.Dropdown(
                    choices=["strip", "placeholder", "drop-if-image-only"],
                    value="strip", label="Image Handling",
                )

            import_btn = gr.Button("Import & Build", variant="primary")
            import_log = gr.Textbox(label="Progress", lines=15)
            import_extract_dir = gr.Textbox(label="Extracted Dir", interactive=False)
            import_dataset_path = gr.Textbox(label="Dataset Path", interactive=False)

            import_btn.click(
                _import_and_build,
                [import_input, import_models, companion_name, import_max, import_image_mode],
                [import_log, import_extract_dir, import_dataset_path],
            )
            # Auto-populate cross-tab state
            import_extract_dir.change(lambda v: v, [import_extract_dir], [shared_extract_dir])

        # ---- Tab 3: Generate Character Card ----
        with gr.Tab("Generate Character Card"):
            gr.Markdown("Generate a CCv3 character card + lorebook from extracted conversations.")

            gen_input_dir = gr.Textbox(
                label="Input Dir (extracted conversations)",
                value=last_extract_dir,
            )
            gen_output_dir = gr.Textbox(label="Output Dir", value=state_str(ui_state.get("gen_output_dir"), "outputs"))
            gen_source_label = gr.Textbox(label="Source Label", value=state_str(ui_state.get("gen_source_label"), ""))

            # These use settings from Tab 1 (preset, model, profile)
            gen_sample_convos = gr.Number(label="Sample Conversations", value=state_int(ui_state.get("gen_sample_conversations"), 12), precision=0)
            gen_max_memories = gr.Number(label="Max Memories", value=state_int(ui_state.get("gen_max_memories"), 24), precision=0)
            gen_temperature = gr.Slider(minimum=0.0, maximum=1.0, step=0.05, value=state_float(ui_state.get("gen_temperature"), 0.2), label="Temperature")

            gen_budget_note = gr.Textbox(label="Budget Auto-Config", lines=3, interactive=False)
            gen_context_window = gr.Number(label="Effective Context Window", value=init_cw, precision=0, interactive=False)

            gen_fresh_scan = gr.Checkbox(label="Fresh scan (ignore previous manifest)", value=False)

            with gr.Accordion("Advanced Budget Overrides", open=False):
                gen_max_msgs = gr.Number(label="Max Messages / Conversation", value=init_msgs, precision=0)
                gen_max_chars_per = gr.Number(label="Max Chars / Conversation", value=init_chars, precision=0)
                gen_max_chars_total = gr.Number(label="Max Total Chars", value=init_total, precision=0)
                gen_timeout = gr.Number(label="Request Timeout Seconds", value=init_timeout, precision=0)

            gen_btn = gr.Button("Generate", variant="primary")
            gen_status = gr.Textbox(label="Status", lines=10)
            gen_report = gr.Textbox(label="Generation Report", lines=15)
            gen_card_path = gr.Textbox(label="Card Path", lines=1)
            gen_lore_path = gr.Textbox(label="Lorebook Path", lines=1)
            gen_misc = gr.Textbox(visible=False)
            gen_card_json = gr.Textbox(label="Character Card JSON (Editable)", lines=18)
            gen_lore_json = gr.Textbox(label="Lorebook JSON (Editable)", lines=18)
            with gr.Row():
                gen_save_card_btn = gr.Button("Save Edited Card")
                gen_save_lore_btn = gr.Button("Save Edited Lorebook")
            gen_json_status = gr.Textbox(label="JSON Save Status", lines=2)

            # Auto-populate from Tab 2
            shared_extract_dir.change(lambda v: v, [shared_extract_dir], [gen_input_dir])

            # Update budget when settings change
            settings_selector.change(
                _budget_defaults, [settings_selector, settings_model, settings_context_profile],
                [gen_budget_note, gen_context_window, gen_max_msgs, gen_max_chars_per, gen_max_chars_total, gen_timeout],
            )
            settings_model.change(
                _budget_defaults, [settings_selector, settings_model, settings_context_profile],
                [gen_budget_note, gen_context_window, gen_max_msgs, gen_max_chars_per, gen_max_chars_total, gen_timeout],
            )
            settings_context_profile.change(
                _budget_defaults, [settings_selector, settings_model, settings_context_profile],
                [gen_budget_note, gen_context_window, gen_max_msgs, gen_max_chars_per, gen_max_chars_total, gen_timeout],
            )

            gen_btn.click(
                _generate_stream,
                [
                    gen_input_dir, gen_output_dir, companion_name, creator_name,
                    gen_source_label, gen_sample_convos, gen_max_memories,
                    settings_context_profile, gen_context_window,
                    gen_max_msgs, gen_max_chars_per, gen_max_chars_total,
                    gen_fresh_scan, settings_selector, settings_model,
                    gen_temperature, gen_timeout,
                    prompt_obs_sys, prompt_obs_usr,
                    prompt_syn_sys, prompt_syn_usr,
                    prompt_mem_sys, prompt_mem_usr,
                    prompt_msyn_sys, prompt_msyn_usr,
                ],
                [gen_status, gen_report, gen_card_path, gen_lore_path, gen_misc, gen_card_json, gen_lore_json],
            )
            gen_save_card_btn.click(
                lambda p, t: _save_json_text(p, t, "Card"),
                [gen_card_path, gen_card_json], [gen_json_status],
            )
            gen_save_lore_btn.click(
                lambda p, t: _save_json_text(p, t, "Lorebook"),
                [gen_lore_path, gen_lore_json], [gen_json_status],
            )
            # Auto-populate fidelity tab
            gen_card_path.change(lambda v: v, [gen_card_path], [shared_card_path])

        # ---- Tab 4: Fidelity Lab ----
        with gr.Tab("Fidelity Lab"):
            gr.Markdown("Compare up to 5 models for personality fidelity against historical transcript.")

            lab_card_path = gr.Textbox(label="Character Card Path", value=last_card)
            lab_transcript_path = gr.Textbox(label="Transcript Path", value=last_transcript)
            lab_output_dir = gr.Textbox(label="Output Dir", value="outputs")

            lab_load_models_btn = gr.Button("Load Models")
            lab_model_status = gr.Textbox(label="Model Load Status", lines=2)
            lab_models = gr.Dropdown(
                label="Candidate Models (up to 5)", choices=initial_models,
                value=[], multiselect=True, allow_custom_value=True,
            )
            lab_prompts = gr.Textbox(
                label="Test Prompts (one per line)",
                value=(
                    "I had a long day and want to reset.\n"
                    "Can you summarize what we focused on recently?\n"
                    "Help me plan tomorrow in a realistic way.\n"
                    "What patterns do you notice in how I solve problems?\n"
                    "Let's pick one concrete next step."
                ),
                lines=7,
            )
            lab_temp = gr.Slider(minimum=0.0, maximum=1.0, step=0.05, value=0.2, label="Temperature")
            lab_timeout = gr.Number(label="Timeout Seconds", value=180, precision=0)

            gr.Markdown("### Optional LLM Judge")
            judge_model_dd = gr.Dropdown(
                label="Judge Model (optional)", choices=initial_models,
                value=initial_model, allow_custom_value=True,
            )

            lab_btn = gr.Button("Run Fidelity Benchmark", variant="primary")
            lab_status = gr.Textbox(label="Status", lines=4)
            lab_summary_md = gr.Markdown(label="Results Summary", value="")
            with gr.Accordion("Raw JSON Report", open=False):
                lab_report = gr.Textbox(label="Fidelity Report JSON", lines=20)
            lab_report_path = gr.Textbox(label="Report Path", lines=1)

            # Auto-populate from generate tab
            shared_card_path.change(lambda v: v, [shared_card_path], [lab_card_path])
            shared_transcript_path.change(lambda v: v, [shared_transcript_path], [lab_transcript_path])

            lab_load_models_btn.click(
                _load_models_multi, [settings_selector], [lab_model_status, lab_models],
            )

            lab_btn.click(
                _run_fidelity,
                [
                    lab_card_path, lab_transcript_path, lab_output_dir,
                    settings_selector, lab_models, lab_prompts,
                    lab_temp, lab_timeout, settings_selector, judge_model_dd,
                ],
                [lab_status, lab_summary_md, lab_report, lab_report_path],
            )

    return demo
