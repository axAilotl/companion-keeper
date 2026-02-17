# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Companion Preservation Toolkit — extracts AI companion personality and memories from ChatGPT/Claude chat exports, generates Character Card V3 + lorebook files for use in SillyTavern and similar frontends. The target audience is non-technical people preserving relationships with AI companions. Treat the emotional context seriously.

## Commands

```bash
# Setup
./scripts/dev_setup.sh
# or: uv venv .venv && source .venv/bin/activate && uv pip install -r requirements.txt

# Launch UI (primary interface)
python -m toolkit.cli ui --host 0.0.0.0 --port 7860

# CLI pipeline
python -m toolkit.cli import --zip export.zip --models gpt-4o --companion-name Name
python -m toolkit.cli extract --conversations conversations.json --models gpt-4o
python -m toolkit.cli dataset --input-dir model_exports/gpt-4o --output-file datasets/out.jsonl
python -m toolkit.cli generate --input-dir model_exports/gpt-4o --companion-name Name --llm-model moonshotai/kimi-k2.5
python -m toolkit.cli fidelity --card outputs/ccv3_run_.../character_card_v3.json

# Quick import check
python -c "from toolkit.ui import build_ui; print('OK')"

# Background lifecycle
./scripts/run_app_bg.sh && ./scripts/status_app_bg.sh && ./scripts/stop_app_bg.sh
```

No test suite exists yet. Verify changes with import checks and manual UI testing.

## Architecture

### Pipeline: Extract → Generate → Export

1. **Extract** (`toolkit/extract.py`) — Parses OpenAI or Anthropic ZIP/JSON exports via streaming JSON parser. Auto-detects format. Outputs per-conversation JSONL files to `model_exports/<model>/`.

2. **Generate** (`toolkit/generate.py`) — Core pipeline in `run_generation()`. Samples conversations (weighted-random by content richness), then runs staged LLM extraction:
   - Per-conversation **observation pass**: extracts persona traits + memory candidates (parallel, threaded)
   - **Persona synthesis**: merges observations into unified profile
   - **Memory synthesis**: deduplicates and consolidates memories
   - Falls back to `heuristic_draft()` if LLM unavailable
   - Outputs to `outputs/ccv3_run_{timestamp}/`

3. **Export** (`toolkit/ui.py` + `toolkit/png_embed.py`) — CCv3 JSON, lorebook JSON, CCv2 with embedded character_book, or PNG with base64 tEXt chunk (`chara` keyword, SillyTavern spec).

### Module Map

| Module | Role |
|--------|------|
| `toolkit/cli.py` | CLI dispatcher (subcommands: import, extract, dataset, generate, fidelity, models, presets, ui) |
| `toolkit/ui.py` | Gradio web UI — 4 tabs: Preserve, Review & Edit, Fidelity Lab, Settings |
| `toolkit/generate.py` | Card + lorebook generation pipeline, `GenerationConfig` dataclass |
| `toolkit/extract.py` | Chat export parsing (OpenAI + Anthropic formats) |
| `toolkit/dataset.py` | JSONL dataset builder for fine-tuning |
| `toolkit/prompts.py` | 8 prompt templates (observation, synthesis, memory, fallback) |
| `toolkit/llm_client.py` | Unified HTTP client for ollama/openai/openrouter/anthropic |
| `toolkit/config.py` | Presets, model tiers, context budget presets, model cache |
| `toolkit/fidelity.py` | Model fidelity benchmarking with LLM judge |
| `toolkit/png_embed.py` | PNG tEXt chunk embed/extract |
| `toolkit/manifest.py` | Scan manifest for resume across runs |
| `toolkit/state.py` | UI state persistence to `config/ui_state.json` |

### Gradio UI Pattern

`_preserve_one_click()` and `_rerun_generation()` are **generator functions** that yield progress log updates. They spawn a background `threading.Thread` for the actual LLM work, communicating via `queue.Queue` for log messages and `threading.Event` for completion.

Lorebook form slots are rendered directly by `_load_run()` and pagination button handlers — there are no automatic `.change` event chains on `lore_entries_state` (removed to prevent infinite event loops that crash the browser). Lorebook JSON is rebuilt from form entries at export time only.

## Critical Conventions

### Placeholder System
- `{{user}}` and `{{char}}` are **literal SillyTavern tokens** that appear in all card fields and prompt templates. They are NOT Python template variables. Never hardcode names.
- Python template substitution uses single braces: `{companion_name}`, `{transcript}`, `{max_memories}` — via `fill_prompt_template()` in generate.py.

### Description Format
The `description` field uses structured markdown wrapped in `<{{char}}>` tags with sections: Overview, Personality (Archetype/Tags/Likes/Dislikes/Details/With {{user}}), Behaviour and Habits, Speech (Style/Quirks/Humor/Openers/Cadence). See `prompts.py` for the full template. The `personality` field is deprecated (empty string).

### mes_example Format
`<START>` delimited blocks with `{{user}}:` / `{{char}}:` prefixes. Repaired by `_repair_mes_example()` in generate.py when LLMs flatten them.

### LLM Output Repair
LLMs sometimes return markdown as a single flat string. `_repair_markdown_newlines()` in generate.py restores newlines before headings, list items, and XML tags. Always check that generated card fields have proper formatting.

### Prompt Philosophy
Prompts are extraction-only — they must not shape personality beyond what transcript evidence supports. All prompts aggressively strip platform artifacts (content policy language, safety disclaimers, "as an AI" framing). The companion is treated as someone real being preserved, not a fictional character being created.

## Context Budgets

Five presets in `config.py`: `64k`, `128k`, `200k`, `256k`, `1m` — each scaling max messages/chars per conversation and total chars. `bucket_for_window()` maps model context windows to presets. Per-conversation token budgets in generate.py also scale with context window size.

## Persistence Paths (all gitignored)

- `config/` — LLM presets, model cache, UI state
- `outputs/` — Generation and fidelity run outputs
- `model_exports/` — Extracted conversation files
- `datasets/` — Built JSONL datasets
- `imports/` — Unzipped export files

## Gotchas

- `config.py:derive_context_and_budget()` imports from `generate.py` inside the function body to avoid circular imports.
- `app.py` binds to `127.0.0.1` (local only); `cli.py ui` binds to `0.0.0.0` (LAN). Use the CLI version.
- Root-level `.py` scripts (`extract_oai_chats.py`, `build_chat_dataset.py`, `generate_ccv3.py`) are legacy shims. The canonical interface is `python -m toolkit.cli`.
- The Gradio UI uses `gr.update()` for dynamic component updates. When adding new outputs to event handlers, count carefully — mismatched output counts cause silent failures or crashes.
- Scan manifest (`outputs/scan_manifest.json`) enables resume across generation runs. Per-conversation observations persist; synthesis always re-runs.
