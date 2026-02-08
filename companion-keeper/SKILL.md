---
name: companion-keeper
description: >
  Extract, reconstruct, and preserve AI companion personalities from OpenAI and Anthropic chat exports.
  Generates Character Card V3 persona cards and lorebooks. Use when the user wants to preserve a companion
  personality, import chat exports, generate character cards, build lorebooks, or benchmark model fidelity
  for personality reproduction.
license: MIT
compatibility: Requires Python 3.11+, internet access for LLM API calls.
metadata:
  author: axailotl
  version: "0.3.0"
---

# Companion Keeper - Agent Skill

You are operating the Companion Keeper CLI toolkit. This tool preserves AI companion personalities by extracting them from chat platform exports and reconstructing them as portable character cards.

## When to Use This Skill

- User wants to preserve or export an AI companion personality
- User has an OpenAI or Anthropic data export (ZIP or `conversations.json`)
- User wants to generate a Character Card V3 from chat history
- User wants to benchmark which inference model best reproduces a companion's voice
- User wants to build a training dataset from chat exports

## Prerequisites

Before running any commands, ensure:

1. The toolkit is installed: `uv sync` or `pip install -r requirements.txt`
2. An LLM preset is configured (needed for generation and fidelity steps):
   - Fastest: create `.env` with `OPENROUTER_API_KEY=sk-or-v1-...`
   - Or manually: `python -m toolkit.cli presets add --name mypreset --provider openrouter --api-key sk-or-...`

## Step-by-Step Workflow

### Step 1: Import and Extract

Determine what export the user has, then import it.

**Detect available models (useful for OpenAI exports):**
```bash
python -m toolkit.cli models --input <path-to-conversations.json-or-zip>
```

**Import and extract conversations:**
```bash
python -m toolkit.cli import \
  --input <path-to-export.zip-or-conversations.json> \
  --models <model-name-or-all> \
  --companion-name "<CompanionName>"
```

- For OpenAI exports: specify the model slug (e.g., `gpt-4o`, `gpt-4`). Use `all` to extract every model.
- For Anthropic exports: always use `--models all`. All conversations go to `model_exports/claude/`.
- Output: `model_exports/<model>/` directory with one `.jsonl` file per conversation.

### Step 2: Generate Character Card + Lorebook

```bash
python -m toolkit.cli generate \
  --input-dir model_exports/<model> \
  --companion-name "<CompanionName>" \
  --creator "<creator-name>" \
  --preset <preset-name> \
  --model <llm-model-id> \
  --sample-conversations 30 \
  --max-memories 24 \
  --output-dir outputs
```

**Key parameters:**
- `--sample-conversations`: More samples = better personality capture. 12 is minimum, 30+ recommended.
- `--max-memories`: Maximum lorebook entries. 24 is default.
- `--context-profile`: Use `auto` (default) or specify `64k`, `128k`, `200k`, `1m`.
- `--fresh`: Add this flag to ignore previous scan manifest and start over.

**Output files** (in `outputs/<run_dir>/`):
- `character_card_v3.json` -- The CCv3 character card
- `lorebook_v3.json` -- Keyword-triggered memory entries
- `persona_payload.json` -- Raw extracted persona data
- `memories_payload.json` -- Raw extracted memories
- `analysis_transcript.txt` -- Baseline transcript for fidelity testing
- `generation_report.json` -- Run metadata and statistics

**Resumability:** If the run is interrupted, re-run the same command. It picks up from the last processed conversation automatically.

### Step 3: Fidelity Benchmark (Optional)

Test which inference model best reproduces the companion's voice:

```bash
python -m toolkit.cli fidelity \
  --card outputs/<run_dir>/character_card_v3.json \
  --transcript outputs/<run_dir>/analysis_transcript.txt \
  --preset <preset-name> \
  --models "model-a,model-b,model-c" \
  --judge-model <judge-model-id>
```

- Tests up to 5 candidate models.
- Scores based on style matching (sentence structure, tone, vocabulary) and optional LLM judge.
- Output: `fidelity_report.json` and `fidelity_summary.md` in the run directory.

## Common Decisions

### Which model for generation?
Recommended for persona extraction (via OpenRouter):
- `moonshotai/kimi-k2.5` -- Best voice capture and behavioral guidance
- `anthropic/claude-sonnet-4-5-20250929` -- Most thorough evidence base

### How many conversations to sample?
- **12**: Quick test run (~26 LLM calls)
- **30**: Good balance of quality vs cost (~62 calls)
- **60**: Comprehensive personality capture (~122 calls)

### OpenAI vs Anthropic exports?
- OpenAI exports include per-message model metadata, so you can filter by model.
- Anthropic exports have no model metadata. All conversations are attributed to `claude`.
- The downstream pipeline handles both identically after extraction.

## Error Recovery

- **Rate limited**: The LLM client has built-in exponential backoff. Re-run the same command.
- **Crashed mid-generation**: The scan manifest tracks progress. Re-run resumes automatically.
- **Bad extraction quality**: Try a different model, increase `--sample-conversations`, or add `--fresh` to rescan.
- **Fidelity scores seem wrong**: Ensure `--transcript` points to the `analysis_transcript.txt` from a completed generation run.

## Web UI Alternative

For interactive use:
```bash
python -m toolkit.cli ui
```
Opens at `http://localhost:7860`. Supports drag-and-drop file upload, editable prompt templates, and live progress display.
