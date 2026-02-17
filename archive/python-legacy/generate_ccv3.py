#!/usr/bin/env python3
"""Backward-compatible CLI for CCv3 character card generation.

All logic lives in toolkit.generate; this shim preserves the original CLI interface.
Prefer: python -m toolkit.cli generate [...]
"""

from __future__ import annotations

import argparse
import json
import os
import time

from toolkit.generate import GenerationConfig, infer_context_window, run_generation


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate Character Card V3 + lorebook from extracted OpenAI chats."
    )
    parser.add_argument("--input-dir", required=True, help="Directory with per-conversation JSONL files.")
    parser.add_argument("--output-dir", default="outputs", help="Output directory (default: outputs)")
    parser.add_argument("--companion-name", required=True, help="Name for the companion persona.")
    parser.add_argument("--creator", default="", help="Creator / user name.")
    parser.add_argument("--source-label", default="openai_export", help="Source label for provenance.")
    parser.add_argument("--sample-conversations", type=int, default=0, help="Number of conversations to sample for persona (0 = auto).")
    parser.add_argument("--memory-sample-conversations", type=int, default=0, help="DEPRECATED: ignored. Use --sample-conversations instead.")
    parser.add_argument("--conversation-sampling", default="weighted_random", choices=["weighted_random", "sequential"], help="Conversation sampling strategy.")
    parser.add_argument("--sampling-seed", type=int, default=42, help="Random seed for sampling.")
    parser.add_argument("--max-memories", type=int, default=150, help="Maximum number of memory entries.")
    parser.add_argument("--memory-per-chat-max", type=int, default=10, help="Max memory extractions per conversation.")
    parser.add_argument("--max-messages-per-conversation", type=int, default=0, help="Truncate long conversations (0 = no limit).")
    parser.add_argument("--max-chars-per-conversation", type=int, default=0, help="Truncate per-conversation text (0 = no limit).")
    parser.add_argument("--max-total-chars", type=int, default=0, help="Total character budget (0 = no limit).")
    parser.add_argument("--model-context-window", type=int, default=0, help="Override model context window size.")
    parser.add_argument("--max-parallel-calls", type=int, default=4, help="Max parallel LLM calls.")
    parser.add_argument(
        "--llm-provider",
        choices=["ollama", "openai", "openrouter", "anthropic"],
        default="openrouter",
        help="LLM provider.",
    )
    parser.add_argument("--llm-base-url", default="", help="Provider base URL override.")
    parser.add_argument("--llm-model", default="openai/gpt-4o-mini", help="Model name to use.")
    parser.add_argument("--llm-api-key", default="", help="API key (or set env var).")
    parser.add_argument("--llm-site-url", default=os.environ.get("OPENROUTER_SITE_URL", "http://localhost"), help="Site URL for OpenRouter headers.")
    parser.add_argument("--llm-app-name", default=os.environ.get("OPENROUTER_APP_NAME", "companion-toolkit"), help="App name for OpenRouter headers.")
    parser.add_argument("--temperature", type=float, default=0.7, help="Sampling temperature.")
    parser.add_argument("--request-timeout", type=int, default=180, help="HTTP timeout in seconds for LLM requests.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    # --memory-sample-conversations is deprecated and ignored
    sample = args.sample_conversations
    if sample <= 0 and args.memory_sample_conversations > 0:
        sample = args.memory_sample_conversations
    config = GenerationConfig(
        input_dir=args.input_dir,
        output_dir=args.output_dir,
        companion_name=args.companion_name,
        creator=args.creator,
        source_label=args.source_label,
        sample_conversations=sample,
        conversation_sampling=args.conversation_sampling,
        sampling_seed=args.sampling_seed,
        max_memories=args.max_memories,
        memory_per_chat_max=args.memory_per_chat_max,
        max_messages_per_conversation=args.max_messages_per_conversation,
        max_chars_per_conversation=args.max_chars_per_conversation,
        max_total_chars=args.max_total_chars,
        model_context_window=args.model_context_window,
        max_parallel_calls=args.max_parallel_calls,
        llm_provider=args.llm_provider,
        llm_base_url=args.llm_base_url,
        llm_model=args.llm_model,
        llm_api_key=args.llm_api_key,
        llm_site_url=args.llm_site_url,
        llm_app_name=args.llm_app_name,
        temperature=args.temperature,
        request_timeout=args.request_timeout,
    )
    started = time.time()
    report = run_generation(config)
    elapsed = time.time() - started
    print(json.dumps({"ok": True, "elapsed_sec": round(elapsed, 2), **report}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
