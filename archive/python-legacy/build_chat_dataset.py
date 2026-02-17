#!/usr/bin/env python3
"""Backward-compatible CLI for chat dataset building.

All logic lives in toolkit.dataset; this shim preserves the original CLI interface.
Prefer: python -m toolkit.cli dataset [...]
"""

from __future__ import annotations

import argparse
import json
import os

from toolkit.dataset import list_input_files, process_file


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build multi-turn chat dataset JSONL from per-conversation exports."
    )
    parser.add_argument("--input-dir", required=True, help="Directory with per-conversation JSONL files.")
    parser.add_argument("--output-file", default="chat_dataset.jsonl", help="Output JSONL path (default: chat_dataset.jsonl)")
    parser.add_argument("--recursive", action="store_true", help="Search input-dir recursively.")
    parser.add_argument("--min-turns", type=int, default=2, help="Minimum turns to keep a conversation (default: 2).")
    parser.add_argument("--max-turns", type=int, default=0, help="Maximum turns to keep (0 = unlimited, default: 0).")
    parser.add_argument("--max-conversations", type=int, default=0, help="Stop after N kept conversations (0 = no limit).")
    parser.add_argument("--keep-system", action="store_true", help="Keep system messages (default: drop).")
    parser.add_argument("--image-mode", choices=["strip", "placeholder", "keep"], default="strip", help="How to handle image content parts.")
    parser.add_argument("--merge-consecutive", action="store_true", default=True, help="Merge consecutive same-role messages (default: True).")
    parser.add_argument("--no-merge", dest="merge_consecutive", action="store_false", help="Disable consecutive-message merging.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    input_files = list_input_files(args.input_dir, args.recursive)
    if not input_files:
        print(f"No input files found in {args.input_dir}")
        return 1

    os.makedirs(os.path.dirname(args.output_file) or ".", exist_ok=True)

    kept = 0
    skipped = 0
    total = 0

    with open(args.output_file, "w", encoding="utf-8") as out:
        for path in input_files:
            total += 1
            item = process_file(
                path,
                min_turns=args.min_turns,
                max_turns=args.max_turns,
                keep_system=args.keep_system,
                image_mode=args.image_mode,
                do_merge=args.merge_consecutive,
            )
            if item is None:
                skipped += 1
            else:
                out.write(json.dumps(item, ensure_ascii=False))
                out.write("\n")
                kept += 1

            if args.max_conversations and kept >= args.max_conversations:
                break

    print(f"Done. total={total} kept={kept} skipped={skipped} output={args.output_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
