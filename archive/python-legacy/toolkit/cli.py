"""Unified CLI for the Companion Preservation Toolkit.

Usage:
    python -m toolkit.cli <command> [options]
    toolkit <command> [options]          # if installed via pyproject.toml

Commands:
    import     Unzip + extract + build dataset in one shot
    extract    Extract conversations by model from conversations.json
    dataset    Build chat dataset JSONL from extracted conversations
    generate   Generate CCv3 character card + lorebook
    fidelity   Run fidelity benchmark across candidate models
    models     List available models from conversations.json
    presets    Manage LLM presets (list, add, remove)
    ui         Launch the Gradio web interface
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import List


def _cmd_import(args: argparse.Namespace) -> int:
    from .extract import resolve_conversations_path, extract_by_models, discover_models, parse_models_arg
    from .dataset import build_dataset

    input_path = args.input
    companion_name = args.companion_name or "Companion"

    print(f"[1/3] Resolving input: {input_path}")
    conv_path, log = resolve_conversations_path(input_path)
    print(log)
    if not conv_path:
        return 1

    # Discover models if "all" or resolve the list
    models_arg = (args.models or "all").strip()
    if models_arg.lower() == "all":
        print("[1/3] Discovering models...")
        msg_counts, convo_counts = discover_models(conv_path)
        model_list = sorted(msg_counts.keys())
        print(f"Found models: {', '.join(model_list)}")
    else:
        model_list = parse_models_arg(models_arg)

    if not model_list:
        print("No models found or specified.")
        return 1

    output_dir = args.output_dir or "model_exports"
    print(f"\n[2/3] Extracting conversations for: {', '.join(model_list)}")
    count, _ = extract_by_models(
        conv_path, model_list, output_dir,
        max_conversations=args.max_conversations or 0,
        log_fn=lambda m: print(f"  {m}"),
    )
    print(f"Extracted {count} conversations to {output_dir}")

    # Build dataset for first model
    primary_model = model_list[0]
    model_dir = os.path.join(output_dir, primary_model)
    if not os.path.isdir(model_dir):
        # Try sanitized name
        from .extract import sanitize_filename
        model_dir = os.path.join(output_dir, sanitize_filename(primary_model))

    dataset_file = args.dataset_file or os.path.join("datasets", f"{primary_model}_chat.jsonl")
    print(f"\n[3/3] Building dataset from {model_dir}")
    try:
        total, kept, skipped = build_dataset(
            model_dir, dataset_file,
            image_mode=args.image_mode or "strip",
            max_conversations=args.max_conversations or 0,
            include_meta=True,
        )
        print(f"Dataset: total={total} kept={kept} skipped={skipped} output={dataset_file}")
    except RuntimeError as exc:
        print(f"Dataset build error: {exc}")
        return 1

    print(f"\nDone. Extracted dir: {model_dir}")
    print(f"Dataset: {dataset_file}")
    return 0


def _cmd_extract(args: argparse.Namespace) -> int:
    from .extract import extract_by_models, discover_models, parse_models_arg

    conv_path = args.input
    if not os.path.isfile(conv_path):
        print(f"Error: file not found: {conv_path}")
        return 1

    models_arg = (args.models or "").strip()
    if models_arg.lower() == "all":
        msg_counts, _ = discover_models(conv_path)
        model_list = sorted(msg_counts.keys())
    else:
        model_list = parse_models_arg(models_arg)

    if not model_list:
        print("No models specified. Use --models or --models all")
        return 1

    output_dir = args.output_dir or "model_exports"
    count, _ = extract_by_models(
        conv_path, model_list, output_dir,
        max_conversations=args.max_conversations or 0,
    )
    print(f"Done. Wrote {count} conversation files to {output_dir}")
    return 0


def _cmd_dataset(args: argparse.Namespace) -> int:
    from .dataset import build_dataset

    try:
        total, kept, skipped = build_dataset(
            args.input_dir, args.output_file,
            image_mode=args.image_mode or "strip",
            max_conversations=args.max_conversations or 0,
            include_meta=args.include_meta,
        )
    except RuntimeError as exc:
        print(f"Error: {exc}")
        return 1

    print(f"Done. total={total} kept={kept} skipped={skipped} output={args.output_file}")
    return 0


def _cmd_generate(args: argparse.Namespace) -> int:
    from .generate import GenerationConfig, run_generation
    from .config import (
        resolve_preset_config, load_dotenv_file, bootstrap_presets_from_env,
        derive_context_and_budget, DEFAULT_CONVERSATION_SAMPLING, DEFAULT_SAMPLING_SEED,
    )

    load_dotenv_file()
    bootstrap_presets_from_env()

    preset_name = (args.preset or "").strip()
    preset = None
    if preset_name:
        preset, err = resolve_preset_config(preset_name)
        if err:
            print(f"Preset error: {err}")
            return 1

    # Resolve context budget
    model = (args.model or (preset or {}).get("model", "") or "").strip()
    _, context_window, budget = derive_context_and_budget(
        preset_name, model, args.context_profile or "auto",
    )

    config = GenerationConfig(
        input_dir=args.input_dir,
        output_dir=args.output_dir or "outputs",
        companion_name=args.companion_name or "Companion",
        creator=args.creator or "unknown",
        source_label=args.source_label or None,
        sample_conversations=args.sample_conversations or 50,
        conversation_sampling=DEFAULT_CONVERSATION_SAMPLING,
        sampling_seed=DEFAULT_SAMPLING_SEED,
        max_memories=args.max_memories or 24,
        memory_per_chat_max=min(12, max(3, (args.max_memories or 24) // 2)),
        max_messages_per_conversation=budget["max_messages_per_conversation"],
        max_chars_per_conversation=budget["max_chars_per_conversation"],
        max_total_chars=budget["max_total_chars"],
        model_context_window=context_window,
        max_parallel_calls=4,
        llm_provider=(preset or {}).get("provider", "ollama"),
        llm_base_url=(preset or {}).get("base_url", ""),
        llm_model=model,
        llm_api_key=(preset or {}).get("api_key", ""),
        llm_site_url=(preset or {}).get("site_url", "http://localhost"),
        llm_app_name=(preset or {}).get("app_name", "companion-preserver"),
        temperature=args.temperature or 0.2,
        request_timeout=budget["request_timeout"],
        fresh_scan=getattr(args, "fresh", False),
    )

    started = time.time()
    report = run_generation(config, log_fn=lambda m: print(f"  {m}"))
    elapsed = time.time() - started
    print(json.dumps({"ok": True, "elapsed_sec": round(elapsed, 2), **report}, ensure_ascii=False, indent=2))
    return 0


def _cmd_fidelity(args: argparse.Namespace) -> int:
    from .fidelity import FidelityConfig, run_fidelity_evaluation
    from .config import resolve_preset_config, resolve_api_key, load_dotenv_file, bootstrap_presets_from_env

    load_dotenv_file()
    bootstrap_presets_from_env()

    preset_name = (args.preset or "").strip()
    preset, err = resolve_preset_config(preset_name)
    if err or not preset:
        print(f"Preset error: {err}")
        return 1

    models = [m.strip() for m in re.split(r"[,\n]+", args.models or "") if m.strip()][:5]
    prompts = [p.strip() for p in (args.test_prompts or "").split(";") if p.strip()]
    if not prompts:
        prompts = [
            "I'm overwhelmed and need help organizing my thoughts.",
            "I feel like we're losing momentum in my healing process.",
            "Can you reflect back what matters most to me right now?",
        ]

    judge_provider = ""
    judge_base_url = ""
    judge_api_key = ""
    judge_site_url = ""
    judge_app_name = ""
    if args.judge_model:
        judge_preset = preset  # reuse same preset for judge
        judge_provider = judge_preset["provider"]
        judge_base_url = judge_preset["base_url"]
        judge_api_key = judge_preset["api_key"]
        judge_site_url = judge_preset.get("site_url", "")
        judge_app_name = judge_preset.get("app_name", "")

    config = FidelityConfig(
        card_path=args.card_path,
        transcript_path=args.transcript_path,
        output_dir=args.output_dir or "outputs",
        provider=preset["provider"],
        base_url=preset["base_url"],
        api_key=preset["api_key"],
        site_url=preset.get("site_url", ""),
        app_name=preset.get("app_name", ""),
        model_names=models,
        test_prompts=prompts,
        temperature=args.temperature or 0.2,
        timeout=args.timeout or 180,
        judge_provider=judge_provider,
        judge_base_url=judge_base_url,
        judge_api_key=judge_api_key,
        judge_site_url=judge_site_url,
        judge_app_name=judge_app_name,
        judge_model=args.judge_model or "",
    )

    report = run_fidelity_evaluation(config)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def _cmd_models(args: argparse.Namespace) -> int:
    from .extract import discover_models

    conv_path = args.input
    if not os.path.isfile(conv_path):
        print(f"Error: file not found: {conv_path}")
        return 1

    msg_counts, convo_counts = discover_models(conv_path)
    print("Models discovered (assistant messages):")
    for m in sorted(msg_counts.keys()):
        print(f"  {m:>20}  messages={msg_counts[m]}  conversations={convo_counts.get(m, 0)}")
    return 0


def _cmd_presets(args: argparse.Namespace) -> int:
    from .config import load_presets, save_presets, load_dotenv_file, bootstrap_presets_from_env
    from .llm_client import default_base_url

    load_dotenv_file()
    bootstrap_presets_from_env()

    action = args.action
    if action == "list":
        presets = load_presets()
        if not presets:
            print("No presets configured.")
            return 0
        for name, p in sorted(presets.items()):
            print(f"  {name}: provider={p.get('provider')} base_url={p.get('base_url')}")
        return 0

    if action == "add":
        name = args.name
        provider = args.provider
        if not name or not provider:
            print("Error: --name and --provider are required for add")
            return 1
        presets = load_presets()
        presets[name] = {
            "provider": provider,
            "base_url": args.base_url or default_base_url(provider),
            "api_key": args.api_key or "",
        }
        save_presets(presets)
        print(f"Saved preset: {name}")
        return 0

    if action == "remove":
        name = args.name
        if not name:
            print("Error: --name is required for remove")
            return 1
        presets = load_presets()
        if name not in presets:
            print(f"Preset not found: {name}")
            return 1
        del presets[name]
        save_presets(presets)
        print(f"Removed preset: {name}")
        return 0

    print(f"Unknown action: {action}")
    return 1


def _cmd_ui(args: argparse.Namespace) -> int:
    from .config import load_dotenv_file, bootstrap_presets_from_env
    load_dotenv_file()
    bootstrap_presets_from_env()

    from .ui import build_ui
    app = build_ui()
    host = args.host or "0.0.0.0"
    port = args.port or 7860
    share = args.share or False
    app.launch(server_name=host, server_port=port, share=share)
    return 0


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="toolkit",
        description="Companion Preservation Toolkit",
    )
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # import
    p_import = subparsers.add_parser("import", help="Unzip + extract + build dataset in one shot")
    p_import.add_argument("--input", required=True, help="Path to ZIP or conversations.json")
    p_import.add_argument("--models", default="all", help="Models to extract (comma-separated or 'all')")
    p_import.add_argument("--companion-name", default="Companion")
    p_import.add_argument("--output-dir", default="model_exports")
    p_import.add_argument("--dataset-file", default="")
    p_import.add_argument("--max-conversations", type=int, default=0)
    p_import.add_argument("--image-mode", default="strip", choices=["strip", "placeholder", "drop-if-image-only"])

    # extract
    p_extract = subparsers.add_parser("extract", help="Extract conversations by model")
    p_extract.add_argument("--input", required=True, help="Path to conversations.json")
    p_extract.add_argument("--models", required=True, help="Models (comma-separated or 'all')")
    p_extract.add_argument("--output-dir", default="model_exports")
    p_extract.add_argument("--max-conversations", type=int, default=0)

    # dataset
    p_dataset = subparsers.add_parser("dataset", help="Build chat dataset JSONL")
    p_dataset.add_argument("--input-dir", required=True)
    p_dataset.add_argument("--output-file", required=True)
    p_dataset.add_argument("--image-mode", default="strip", choices=["strip", "placeholder", "drop-if-image-only"])
    p_dataset.add_argument("--max-conversations", type=int, default=0)
    p_dataset.add_argument("--include-meta", action="store_true")

    # generate
    p_gen = subparsers.add_parser("generate", help="Generate CCv3 character card + lorebook")
    p_gen.add_argument("--input-dir", required=True)
    p_gen.add_argument("--companion-name", default="Companion")
    p_gen.add_argument("--creator", default="unknown")
    p_gen.add_argument("--source-label", default="")
    p_gen.add_argument("--preset", default="", help="LLM preset name")
    p_gen.add_argument("--model", default="", help="LLM model name")
    p_gen.add_argument("--context-profile", default="auto")
    p_gen.add_argument("--output-dir", default="outputs")
    p_gen.add_argument("--sample-conversations", type=int, default=50)
    p_gen.add_argument("--max-memories", type=int, default=24)
    p_gen.add_argument("--temperature", type=float, default=0.2)
    p_gen.add_argument("--fresh", action="store_true", help="Ignore existing scan manifest and start fresh")

    # fidelity
    p_fid = subparsers.add_parser("fidelity", help="Run fidelity benchmark")
    p_fid.add_argument("--card-path", required=True)
    p_fid.add_argument("--transcript-path", required=True)
    p_fid.add_argument("--models", required=True, help="Candidate models (comma-separated)")
    p_fid.add_argument("--preset", default="", help="LLM preset name")
    p_fid.add_argument("--output-dir", default="outputs")
    p_fid.add_argument("--temperature", type=float, default=0.2)
    p_fid.add_argument("--timeout", type=int, default=180)
    p_fid.add_argument("--test-prompts", default="", help="Test prompts separated by semicolons")
    p_fid.add_argument("--judge-model", default="")

    # models
    p_models = subparsers.add_parser("models", help="List models from conversations.json")
    p_models.add_argument("--input", required=True, help="Path to conversations.json")

    # presets
    p_presets = subparsers.add_parser("presets", help="Manage LLM presets")
    p_presets.add_argument("action", choices=["list", "add", "remove"])
    p_presets.add_argument("--name", default="")
    p_presets.add_argument("--provider", default="")
    p_presets.add_argument("--base-url", default="")
    p_presets.add_argument("--api-key", default="")

    # ui
    p_ui = subparsers.add_parser("ui", help="Launch Gradio web interface")
    p_ui.add_argument("--host", default="0.0.0.0")
    p_ui.add_argument("--port", type=int, default=7860)
    p_ui.add_argument("--share", action="store_true")

    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help()
        return 1

    commands = {
        "import": _cmd_import,
        "extract": _cmd_extract,
        "dataset": _cmd_dataset,
        "generate": _cmd_generate,
        "fidelity": _cmd_fidelity,
        "models": _cmd_models,
        "presets": _cmd_presets,
        "ui": _cmd_ui,
    }
    handler = commands.get(args.command)
    if not handler:
        parser.print_help()
        return 1
    return handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
