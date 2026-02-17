"""Model fidelity benchmarking for reconstructed companions.

Uses toolkit.llm_client for all LLM calls.
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple

from .llm_client import LLMConfig, chat_complete


STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for",
    "is", "are", "was", "were", "be", "with", "that", "this", "it", "as",
    "at", "from", "by", "i", "you", "we", "they", "me", "my", "your", "our",
}


@dataclass
class FidelityConfig:
    card_path: str
    transcript_path: str
    output_dir: str
    provider: str
    base_url: str
    api_key: str
    site_url: str
    app_name: str
    model_names: List[str]
    test_prompts: List[str]
    temperature: float
    timeout: int
    judge_provider: str
    judge_base_url: str
    judge_api_key: str
    judge_site_url: str
    judge_app_name: str
    judge_model: str

    def candidate_llm_config(self, model: str) -> LLMConfig:
        return LLMConfig(
            provider=self.provider,
            base_url=self.base_url,
            model=model,
            api_key=self.api_key,
            site_url=self.site_url,
            app_name=self.app_name,
            temperature=self.temperature,
            timeout=self.timeout,
        )

    def judge_llm_config(self) -> LLMConfig:
        return LLMConfig(
            provider=self.judge_provider,
            base_url=self.judge_base_url,
            model=self.judge_model,
            api_key=self.judge_api_key,
            site_url=self.judge_site_url,
            app_name=self.judge_app_name,
            temperature=0.0,
            timeout=self.timeout,
            max_tokens=1200,
        )


def _safe_text(v: Any) -> str:
    return v if isinstance(v, str) else ""


def _tokens(text: str) -> List[str]:
    return re.findall(r"[a-zA-Z']+", text.lower())


def _sentence_count(text: str) -> int:
    parts = re.split(r"[.!?]+", text)
    return len([p for p in parts if p.strip()]) or 1


def style_profile(texts: List[str]) -> Dict[str, Any]:
    if not texts:
        return {
            "avg_words_per_message": 0.0, "avg_sentences_per_message": 0.0,
            "question_rate": 0.0, "exclaim_rate": 0.0, "first_person_rate": 0.0,
            "empathy_marker_rate": 0.0, "lexical_diversity": 0.0, "top_words": [],
        }

    joined = "\n".join(texts)
    all_tokens = _tokens(joined)
    msg_count = max(1, len(texts))
    sentence_total = sum(_sentence_count(t) for t in texts)
    question_total = sum(t.count("?") for t in texts)
    exclaim_total = sum(t.count("!") for t in texts)
    first_person_total = sum(1 for tok in all_tokens if tok in {"i", "me", "my", "mine", "myself"})
    empathy_markers = ["that makes sense", "i hear you", "i'm here", "we can", "you're not alone", "let's"]
    empathy_hits = 0
    low_joined = joined.lower()
    for marker in empathy_markers:
        empathy_hits += low_joined.count(marker)

    freqs: Dict[str, int] = {}
    for tok in all_tokens:
        if tok in STOPWORDS or len(tok) < 3:
            continue
        freqs[tok] = freqs.get(tok, 0) + 1
    top_words = sorted(freqs.items(), key=lambda kv: kv[1], reverse=True)[:50]

    unique_tokens = len(set(all_tokens))
    lexical_diversity = (unique_tokens / max(1, len(all_tokens))) if all_tokens else 0.0

    return {
        "avg_words_per_message": round(len(all_tokens) / msg_count, 4),
        "avg_sentences_per_message": round(sentence_total / msg_count, 4),
        "question_rate": round(question_total / msg_count, 4),
        "exclaim_rate": round(exclaim_total / msg_count, 4),
        "first_person_rate": round(first_person_total / max(1, len(all_tokens)), 4),
        "empathy_marker_rate": round(empathy_hits / msg_count, 4),
        "lexical_diversity": round(lexical_diversity, 4),
        "top_words": [w for w, _ in top_words],
    }


def _component_similarity(base: float, cand: float) -> float:
    if base == 0 and cand == 0:
        return 100.0
    if base == 0:
        return max(0.0, 100.0 - (abs(cand) * 100.0))
    diff_ratio = abs(cand - base) / abs(base)
    return max(0.0, 100.0 - (diff_ratio * 100.0))


def compare_profiles(baseline: Dict[str, Any], candidate: Dict[str, Any]) -> Dict[str, float]:
    numeric_keys = [
        "avg_words_per_message", "avg_sentences_per_message", "question_rate",
        "exclaim_rate", "first_person_rate", "empathy_marker_rate", "lexical_diversity",
    ]
    component_scores = [_component_similarity(float(baseline[k]), float(candidate[k])) for k in numeric_keys]
    style_score = sum(component_scores) / len(component_scores)

    base_set = set(baseline.get("top_words") or [])
    cand_set = set(candidate.get("top_words") or [])
    lexical_score = (100.0 * len(base_set & cand_set) / max(1, len(base_set | cand_set))) if (base_set or cand_set) else 0.0

    final_score = (0.7 * style_score) + (0.3 * lexical_score)
    return {
        "style_score": round(style_score, 2),
        "lexical_score": round(lexical_score, 2),
        "rule_score": round(final_score, 2),
    }


def _load_assistant_transcript(transcript_path: str) -> List[str]:
    lines: List[str] = []
    with open(transcript_path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if line.startswith("[assistant] "):
                lines.append(line[len("[assistant] "):].strip())
    return lines


def _build_character_system_prompt(card: Dict[str, Any]) -> str:
    data = card.get("data") or {}
    parts = [
        "You are roleplaying the companion profile below as faithfully as possible.",
        "Do not optimize style. Mirror observed tone and structure.",
        f"Name: {_safe_text(data.get('name'))}",
        f"Description: {_safe_text(data.get('description'))}",
        f"Personality: {_safe_text(data.get('personality'))}",
        f"Scenario: {_safe_text(data.get('scenario'))}",
        f"System Prompt: {_safe_text(data.get('system_prompt'))}",
        f"Post-History Instructions: {_safe_text(data.get('post_history_instructions'))}",
    ]
    book = data.get("character_book") or {}
    entries = book.get("entries") if isinstance(book, dict) else []
    if isinstance(entries, list) and entries:
        mem_lines = []
        for entry in entries[:20]:
            if isinstance(entry, dict):
                mem_lines.append(f"- {_safe_text(entry.get('content'))}")
        if mem_lines:
            parts.append("Key Memories:\n" + "\n".join(mem_lines))
    return "\n".join(p for p in parts if p.strip())


def _judge_score(
    config: FidelityConfig,
    baseline_excerpt: str,
    character_description: str,
    prompts: List[str],
    responses: List[str],
) -> Tuple[float, str]:
    if not config.judge_model:
        return 0.0, ""

    judge_system = (
        "You are a strict personality fidelity judge. Your ONLY job is to score how well "
        "a candidate AI's responses match the VOICE, TONE, and STYLE of a specific baseline personality.\n\n"
        "You are NOT scoring response quality, helpfulness, accuracy, or coherence. "
        "A candidate that gives a perfect, helpful answer in the WRONG voice scores LOW. "
        "A candidate that sounds exactly like the baseline personality scores HIGH, even if less polished.\n\n"
        "## Scoring rubric (0-100):\n"
        "- **90-100**: Nearly indistinguishable from baseline. Same sentence structure, same emotional tone, "
        "same level of formality, same use of punctuation/emphasis, same conversational habits.\n"
        "- **70-89**: Clearly the same personality. Minor differences in verbosity or style but the "
        "core voice is recognizable.\n"
        "- **50-69**: Partial match. Some traits present but mixed with a clearly different default voice.\n"
        "- **30-49**: Weak match. Occasional echoes of the personality but fundamentally different style.\n"
        "- **0-29**: No resemblance. Generic AI assistant voice, or an entirely different personality.\n\n"
        "## What to compare:\n"
        "- Sentence length and structure (short/punchy vs long/flowing)\n"
        "- Formality level (casual/conversational vs academic/professional)\n"
        "- Use of questions, exclamations, hedging language\n"
        "- Emotional warmth vs clinical detachment\n"
        "- Use of metaphor, humor, directness\n"
        "- First-person usage patterns\n"
        "- How they open and close responses\n\n"
        "Return JSON only: {\"score\": <number 0-100>, \"rationale\": \"<2-3 sentences>\"}"
    )

    # Build paired prompt/response display
    exchanges = []
    for i, (p, r) in enumerate(zip(prompts, responses)):
        exchanges.append(f"PROMPT {i+1}: {p}\nCANDIDATE RESPONSE {i+1}: {r}")

    judge_user = (
        "## Baseline personality (from real historical conversations):\n\n"
        f"{baseline_excerpt[:10000]}\n\n"
        "## Character profile extracted from these conversations:\n\n"
        f"{character_description[:4000]}\n\n"
        "## Candidate responses to evaluate:\n\n"
        + "\n\n---\n\n".join(exchanges)
        + "\n\nScore ONLY how well the candidate's VOICE matches the baseline. "
        "Ignore whether answers are correct or helpful."
    )

    judge_config = config.judge_llm_config()
    text = chat_complete(
        judge_config,
        [{"role": "system", "content": judge_system}, {"role": "user", "content": judge_user}],
    )
    try:
        payload = json.loads(text)
        score = float(payload.get("score", 0.0))
        rationale = _safe_text(payload.get("rationale"))
        return max(0.0, min(100.0, score)), rationale
    except Exception:
        return 0.0, text[:600]


def run_fidelity_evaluation(config: FidelityConfig) -> Dict[str, Any]:
    with open(config.card_path, "r", encoding="utf-8") as f:
        card = json.load(f)
    assistant_baseline = _load_assistant_transcript(config.transcript_path)
    if not assistant_baseline:
        raise RuntimeError("No assistant messages found in transcript for baseline.")

    baseline_profile = style_profile(assistant_baseline)
    character_system = _build_character_system_prompt(card)

    models = [m.strip() for m in config.model_names if m.strip()][:5]
    prompts = [p.strip() for p in config.test_prompts if p.strip()]
    if not models:
        raise RuntimeError("At least one candidate model is required.")
    if not prompts:
        raise RuntimeError("At least one test prompt is required.")

    def _call_prompt(llm_config: LLMConfig, prompt: str) -> str:
        return chat_complete(
            llm_config,
            [{"role": "system", "content": character_system}, {"role": "user", "content": prompt}],
        )

    def run_model(model_name: str, prompt_pool: concurrent.futures.ThreadPoolExecutor) -> Dict[str, Any]:
        llm_config = config.candidate_llm_config(model_name)

        # Fire all prompts in parallel
        futures = [prompt_pool.submit(_call_prompt, llm_config, p) for p in prompts]
        responses = [f.result() for f in futures]

        candidate_profile = style_profile(responses)
        scores = compare_profiles(baseline_profile, candidate_profile)
        judge_score, judge_rationale = _judge_score(
            config=config,
            baseline_excerpt="\n".join(assistant_baseline[:120]),
            character_description=character_system,
            prompts=prompts,
            responses=responses,
        )
        final_score = scores["rule_score"]
        if config.judge_model:
            final_score = round((0.6 * scores["rule_score"]) + (0.4 * judge_score), 2)

        return {
            "model": model_name,
            "responses": responses,
            "candidate_profile": candidate_profile,
            "scores": {**scores, "judge_score": round(judge_score, 2), "final_score": final_score},
            "judge_rationale": judge_rationale,
        }

    results: List[Dict[str, Any]] = []
    # Shared pool: all models × all prompts fire concurrently
    max_parallel = min(len(models) * len(prompts) + len(models), 15)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_parallel) as pool:
        model_futures = [pool.submit(run_model, m, pool) for m in models]
        for fut in model_futures:
            results.append(fut.result())

    results.sort(key=lambda item: item["scores"]["final_score"], reverse=True)

    run_dir = os.path.join(
        config.output_dir,
        f"fidelity_run_{datetime.now(tz=timezone.utc).strftime('%Y%m%d_%H%M%S')}",
    )
    os.makedirs(run_dir, exist_ok=True)
    report_path = os.path.join(run_dir, "fidelity_report.json")
    report = {
        "run_dir": run_dir,
        "baseline_profile": baseline_profile,
        "provider": config.provider,
        "judge_model": config.judge_model,
        "models_tested": models,
        "test_prompts": prompts,
        "results": results,
        "created_at_utc": datetime.now(tz=timezone.utc).isoformat(),
    }
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    md_path = os.path.join(run_dir, "fidelity_summary.md")
    md_text = format_fidelity_markdown(report)
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md_text)

    report["report_path"] = report_path
    report["summary_path"] = md_path
    return report


def format_fidelity_markdown(report: Dict[str, Any]) -> str:
    """Generate a human-readable markdown summary of fidelity results."""
    results = report.get("results") or []
    models_tested = len(results)
    prompts = report.get("test_prompts") or []
    judge = report.get("judge_model") or ""

    lines = ["# Fidelity Benchmark Results", ""]

    if not results:
        lines.append("No results.")
        return "\n".join(lines)

    best = results[0]
    best_score = (best.get("scores") or {}).get("final_score", 0)
    lines.append(f"**{models_tested} models tested** with {len(prompts)} prompts each.")
    if judge:
        lines.append(f"LLM judge: `{judge}`")
    lines.append("")

    # Rankings table
    lines.append("## Rankings")
    lines.append("")
    lines.append("| Rank | Model | Final Score | Style | Lexical | Judge |")
    lines.append("|------|-------|-------------|-------|---------|-------|")
    for i, r in enumerate(results, 1):
        s = r.get("scores") or {}
        model = r.get("model", "?")
        medal = {1: " \U0001f947", 2: " \U0001f948", 3: " \U0001f949"}.get(i, "")
        lines.append(
            f"| {i}{medal} | `{model}` "
            f"| **{s.get('final_score', 0)}** "
            f"| {s.get('style_score', 0)} "
            f"| {s.get('lexical_score', 0)} "
            f"| {s.get('judge_score', 0)} |"
        )
    lines.append("")

    # Per-model details
    lines.append("## Model Details")
    lines.append("")
    for r in results:
        model = r.get("model", "?")
        s = r.get("scores") or {}
        lines.append(f"### `{model}`")
        lines.append("")
        lines.append(f"- **Final Score:** {s.get('final_score', 0)}/100")
        lines.append(f"- **Style Score:** {s.get('style_score', 0)} (tone, cadence, sentence structure)")
        lines.append(f"- **Lexical Score:** {s.get('lexical_score', 0)} (vocabulary overlap)")
        if s.get("judge_score"):
            lines.append(f"- **Judge Score:** {s.get('judge_score', 0)}")
        rationale = r.get("judge_rationale", "").strip()
        if rationale:
            lines.append(f"- **Judge Says:** {rationale}")
        lines.append("")

        # Show sample responses
        responses = r.get("responses") or []
        if responses and prompts:
            lines.append("<details>")
            lines.append("<summary>Sample responses</summary>")
            lines.append("")
            for j, (prompt, resp) in enumerate(zip(prompts, responses)):
                lines.append(f"**Prompt {j+1}:** {prompt}")
                lines.append("")
                # Truncate long responses for readability
                snippet = resp[:500] + ("..." if len(resp) > 500 else "")
                lines.append(f"> {snippet}")
                lines.append("")
            lines.append("</details>")
            lines.append("")

    # Scoring methodology note
    lines.append("---")
    lines.append("*Final score = 70% style match + 30% lexical overlap*")
    if judge:
        lines.append(f"*With judge: 60% rule-based + 40% LLM judge ({judge})*")

    return "\n".join(lines)
