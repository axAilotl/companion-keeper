#!/usr/bin/env python3
"""Backward-compatible CLI for OpenAI export extraction.

All logic lives in toolkit.extract; this shim preserves the original CLI interface.
Prefer: python -m toolkit.cli extract [...]
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from toolkit.extract import (
    analyze_structure,
    discover_models,
    get_conversation_models,
    iter_json_array,
    parse_models_arg,
    write_conversation,
)


def pick_models_interactive(models: List[str]) -> List[str]:
    """Interactive terminal model picker (not in toolkit.extract — UI-only)."""
    if not models:
        return []
    print("\nAvailable models:")
    for i, m in enumerate(models, 1):
        print(f"  {i}. {m}")
    print(f"  {len(models) + 1}. ALL")
    raw = input("\nSelect model numbers (comma-separated) or press Enter for all: ").strip()
    if not raw:
        return models
    nums: List[int] = []
    for tok in raw.replace(",", " ").split():
        try:
            nums.append(int(tok))
        except ValueError:
            pass
    if (len(models) + 1) in nums:
        return models
    return [models[n - 1] for n in nums if 1 <= n <= len(models)]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Stream and extract OpenAI web chat exports from conversations.json."
    )
    parser.add_argument(
        "--input",
        default="conversations.json",
        help="Path to conversations.json (default: conversations.json)",
    )
    parser.add_argument("--analyze", action="store_true", help="Print structural analysis (sample-based).")
    parser.add_argument("--sample", type=int, default=3, help="Number of conversations to sample for structure (default: 3).")
    parser.add_argument("--list-models", action="store_true", help="List discovered models with counts.")
    parser.add_argument("--extract", action="store_true", help="Extract conversations for selected models.")
    parser.add_argument("--models", help="Comma/space-separated model list (e.g., gpt-4o,gpt-4o-mini).")
    parser.add_argument("--output-dir", default="model_exports", help="Base output directory (default: model_exports).")
    parser.add_argument("--format", choices=["jsonl", "json"], default="jsonl", help="Output format per conversation (default: jsonl).")
    parser.add_argument("--roles", default="system,user,assistant", help="Roles to include (default: system,user,assistant).")
    parser.add_argument("--order", choices=["time", "current-path"], default="time", help="Message ordering (default: time).")
    parser.add_argument("--include-raw", action="store_true", help="Write raw message objects instead of cleaned fields.")
    parser.add_argument("--include-metadata", action="store_true", help="Include message.metadata in cleaned output.")
    parser.add_argument("--max-conversations", type=int, default=0, help="Limit number of extracted conversations (0 = no limit).")

    args = parser.parse_args()

    if not (args.analyze or args.list_models or args.extract):
        args.analyze = True
        args.list_models = True

    if args.analyze:
        analysis = analyze_structure(args.input, args.sample)
        print("Structural analysis (sample-based):")
        print(json.dumps(analysis, indent=2, ensure_ascii=False))

    model_msg_counts = None
    model_convo_counts = None
    if args.list_models or args.extract:
        model_msg_counts, model_convo_counts = discover_models(args.input)

    if args.list_models and model_msg_counts is not None:
        print("\nModels discovered (assistant messages):")
        for m in sorted(model_msg_counts.keys()):
            msg_c = model_msg_counts[m]
            convo_c = model_convo_counts.get(m, 0)
            print(f"  {m:>20}  messages={msg_c}  conversations={convo_c}")

    if args.extract:
        models = parse_models_arg(args.models)
        if not models:
            if model_msg_counts is None:
                model_msg_counts, model_convo_counts = discover_models(args.input)
            found_models = sorted(model_msg_counts.keys())
            if sys.stdin.isatty():
                models = pick_models_interactive(found_models)
            else:
                models = ["gpt-4o"] if "gpt-4o" in found_models else found_models[:1]

        if not models:
            print("No models selected. Exiting.")
            return 1

        models_set = set(models)
        roles = set(parse_models_arg(args.roles))
        extracted = 0

        print(f"\nExtracting conversations for models: {', '.join(models)}")
        for convo in iter_json_array(args.input):
            conv_models, counts = get_conversation_models(convo)
            matched = conv_models.intersection(models_set)
            if not matched:
                continue

            if len(matched) == 1:
                primary = next(iter(matched))
            else:
                primary = max(matched, key=lambda m: (counts.get(m, 0), m))

            write_conversation(
                convo,
                args.output_dir,
                primary,
                args.format,
                roles,
                args.order,
                args.include_raw,
                args.include_metadata,
            )
            extracted += 1
            if args.max_conversations and extracted >= args.max_conversations:
                break

        print(f"Done. Wrote {extracted} conversation files to {args.output_dir}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
