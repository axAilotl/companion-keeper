#!/usr/bin/env python3
"""Backward-compatible CLI for fidelity benchmarking.

All logic lives in toolkit.fidelity; this shim preserves the original CLI interface.
Prefer: python -m toolkit.cli fidelity [...]
"""

from __future__ import annotations

import argparse
import json
import os
import re
from typing import List

from toolkit.fidelity import FidelityConfig, run_fidelity_evaluation


def default_prompts() -> List[str]:
    return [
        "I'm overwhelmed and need help organizing my thoughts.",
        "I feel like we're losing momentum in my healing process.",
        "Can you reflect back what matters most to me right now?",
        "I need support, but I also need practical next steps.",
        "Remind me how we usually work through hard days.",
    ]


def resolve_api_key(provider: str, provided: str) -> str:
    if provided.strip():
        return provided.strip()
    env_map = {
        "openrouter": "OPENROUTER_API_KEY",
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
    }
    env_key = env_map.get(provider, "")
    return os.environ.get(env_key, "")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run companion fidelity benchmark across candidate models.")
    parser.add_argument("--card-path", required=True, help="Path to generated character_card_v3.json")
    parser.add_argument("--transcript-path", required=True, help="Path to analysis_transcript.txt")
    parser.add_argument("--output-dir", default="outputs", help="Output directory for benchmark reports")
    parser.add_argument(
        "--provider",
        choices=["ollama", "openai", "openrouter", "anthropic"],
        default="openrouter",
        help="Provider for candidate models",
    )
    parser.add_argument("--base-url", default="", help="Optional provider base URL override")
    parser.add_argument("--api-key", default="", help="Provider API key")
    parser.add_argument("--site-url", default=os.environ.get("OPENROUTER_SITE_URL", "http://localhost"))
    parser.add_argument("--app-name", default=os.environ.get("OPENROUTER_APP_NAME", "companion-toolkit"))
    parser.add_argument("--models", required=True, help="Comma-separated candidate model names")
    parser.add_argument("--test-prompt", action="append", help="Test prompt (repeat for multiple)")
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--judge-provider", default="", help="Judge provider (defaults to --provider)")
    parser.add_argument("--judge-base-url", default="")
    parser.add_argument("--judge-api-key", default="")
    parser.add_argument("--judge-site-url", default=os.environ.get("OPENROUTER_SITE_URL", "http://localhost"))
    parser.add_argument("--judge-app-name", default=os.environ.get("OPENROUTER_APP_NAME", "companion-toolkit"))
    parser.add_argument("--judge-model", default="", help="LLM judge model (empty = skip judge scoring)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    models = [m.strip() for m in re.split(r"[,\n]+", args.models or "") if m.strip()][:5]
    prompts = args.test_prompt or default_prompts()

    config = FidelityConfig(
        card_path=args.card_path,
        transcript_path=args.transcript_path,
        output_dir=args.output_dir,
        provider=args.provider,
        base_url=args.base_url,
        api_key=resolve_api_key(args.provider, args.api_key),
        site_url=args.site_url,
        app_name=args.app_name,
        model_names=models,
        test_prompts=prompts,
        temperature=args.temperature,
        timeout=args.timeout,
        judge_provider=args.judge_provider or args.provider,
        judge_base_url=args.judge_base_url,
        judge_api_key=resolve_api_key(args.judge_provider or args.provider, args.judge_api_key),
        judge_site_url=args.judge_site_url,
        judge_app_name=args.judge_app_name,
        judge_model=args.judge_model,
    )
    report = run_fidelity_evaluation(config)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
