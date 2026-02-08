# Repository Guidelines

## Project Purpose
Companion Keeper extracts AI companion personalities from chat platform exports (OpenAI, Anthropic) and reconstructs them as portable Character Card V3 persona cards with lorebook memories.

## Key Files
- `toolkit/` -- All source code as a Python package.
- `toolkit/cli.py` -- Unified CLI entry point (`python -m toolkit.cli`).
- `toolkit/extract.py` -- Export format detection and conversation extraction (OpenAI + Anthropic).
- `toolkit/generate.py` -- CCv3 card + lorebook generation pipeline.
- `toolkit/fidelity.py` -- Model fidelity benchmarking.
- `toolkit/ui.py` -- Gradio web interface.
- `toolkit/config.py` -- Presets, context budgets, .env loading.
- `toolkit/llm_client.py` -- Provider-agnostic LLM client with retry/backoff.
- `toolkit/prompts.py` -- All LLM prompt templates.
- `toolkit/dataset.py` -- Chat dataset JSONL builder.
- `toolkit/manifest.py` -- Scan continuation manifest for resumable runs.
- `toolkit/state.py` -- UI state persistence.
- `scripts/` -- Shell helpers for background service management.

## Common Commands

### Import & Extract
```bash
# OpenAI export
python -m toolkit.cli import --input export.zip --models gpt-4o --companion-name Companion

# Anthropic export
python -m toolkit.cli import --input anthropic-export.zip --models all --companion-name Companion

# List available models in an export
python -m toolkit.cli models --input conversations.json
```

### Generate Character Card
```bash
python -m toolkit.cli generate \
  --input-dir model_exports/gpt-4o \
  --companion-name Companion \
  --creator username \
  --preset openrouter-env \
  --model moonshotai/kimi-k2.5 \
  --sample-conversations 30
```

### Fidelity Benchmark
```bash
python -m toolkit.cli fidelity \
  --card outputs/latest_run/character_card_v3.json \
  --transcript outputs/latest_run/analysis_transcript.txt \
  --preset openrouter-env \
  --models "model-a,model-b,model-c" \
  --judge-model anthropic/claude-sonnet-4-5-20250929
```

### Web UI
```bash
python -m toolkit.cli ui
```

### Preset Management
```bash
python -m toolkit.cli presets list
python -m toolkit.cli presets add --name mypreset --provider openrouter --api-key sk-or-...
python -m toolkit.cli presets remove --name mypreset
```

## Architecture

### Pipeline Flow
1. **Import**: ZIP/JSON input -> format detection -> unzip -> `conversations.json`
2. **Extract**: Stream-parse conversations -> filter by model -> write per-conversation JSONL to `model_exports/<model>/`
3. **Dataset**: Merge per-conversation JSONL into training-format dataset (optional)
4. **Generate**: Sample conversations -> parallel LLM extraction (persona + memory per conversation) -> synthesis -> CCv3 card + lorebook
5. **Fidelity**: Load card + transcript -> generate candidate responses -> compare style profiles + LLM judge scoring

### Format Detection
- `detect_export_format(path)` peeks at the first JSON object in the array.
- `mapping` key -> OpenAI format (tree-structured conversations with model metadata).
- `chat_messages` key -> Anthropic format (flat message arrays, no model metadata).
- Downstream pipeline (generate, dataset) is format-agnostic -- it reads intermediate JSONL with `{role, text, parts}`.

### LLM Integration
- All LLM calls go through `toolkit/llm_client.py` with exponential backoff retry.
- Supported providers: `openrouter`, `ollama`, `openai-compatible`.
- Context budgets auto-scale based on model context window (auto-detected or manual profile).

### Scan Continuation
- `toolkit/manifest.py` tracks processed files in `scan_manifest.json`.
- Interrupted runs resume from last checkpoint.
- Use `--fresh` flag to ignore manifest and start over.

## Data Handling Notes
- Default conversion drops tool messages, empty system messages, and `user_editable_context`.
- Multimodal content is stripped to text by default.
- Consecutive same-role messages are merged.
- Anthropic exports filter out `tool_use`, `tool_result`, `thinking`, and `token_budget` content blocks -- only `text` blocks are extracted.

## Provider Support
- `openrouter` -- Recommended. Access to all models through one API key.
- `ollama` -- Local inference.
- `openai-compatible` -- Any OpenAI-compatible API endpoint.
