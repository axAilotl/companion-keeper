# Repository Guidelines

## Project Purpose
This workspace contains an OpenAI data export and tooling to:
- Analyze `conversations.json` structure and model usage.
- Extract GPT-4o (or other model) chats into per-conversation files.
- Convert per-conversation exports into multi-turn chat datasets (JSONL) for fine-tuning.

## Key Files
- `conversations.json` — full export from OpenAI web chat.
- `extract_oai_chats.py` — streaming extractor + structural analysis + model discovery.
- `build_chat_dataset.py` — converts per-conversation JSONL into OpenAI-style chat JSONL.
- `model_exports/` — output from extraction, grouped by model.
- `datasets/` — output datasets for training.

## Common Commands
- Structural analysis + model list:
  - `python extract_oai_chats.py --analyze --sample 3`
  - `python extract_oai_chats.py --list-models`
- Extract GPT-4o chats:
  - `python extract_oai_chats.py --extract --models gpt-4o`
- Build dataset (full):
  - `python build_chat_dataset.py --input-dir model_exports/gpt-4o --output-file datasets/gpt-4o_chat.jsonl`
- Build dataset (sample):
  - `python build_chat_dataset.py --input-dir model_exports/gpt-4o --output-file datasets/gpt-4o_chat_sample.jsonl --max-conversations 50`
- Generate CCv3 card + lorebook (heuristic fallback):
  - `python generate_ccv3.py --input-dir model_exports/gpt-4o --output-dir outputs --companion-name Companion --llm-model ''`
- Run GUI:
  - `python app.py`
- App lifecycle helpers:
  - `./scripts/run_app_bg.sh`
  - `./scripts/status_app_bg.sh`
  - `./scripts/stop_app_bg.sh`
- Setup Python env (uv + venv):
  - `./scripts/dev_setup.sh`
  - or manually: `uv venv .venv && source .venv/bin/activate && uv pip install -r requirements.txt`

## Data Handling Notes
- Default conversion drops tool messages, empty system messages, and `user_editable_context`.
- Multimodal content is stripped to text by default; optional placeholder support is available.
- Consecutive same-role messages are merged by default.

## Current Review (2026-02-06)
- Existing strengths:
  - `extract_oai_chats.py` already does streaming extraction by assistant model and supports large `conversations.json`.
  - `build_chat_dataset.py` already produces clean OpenAI-style instruction chat JSONL for fine-tuning.
  - Export shape in `oai_export_2-4-26.zip` matches current extractor assumptions (`conversations.json` at root).
  - GUI generation flow now supports context presets (`64k/128k/200k/1M` + auto) and live stage logs during CCv3/lorebook extraction.
- Current gaps for companion-preservation workflow:
  - Need stronger default quality presets for persona extraction across larger chat samples.
  - Need clearer in-app guidance for long-running jobs and runtime/cost expectations.
  - Need broader validation/evaluation runs across multiple candidate models for fidelity scoring.
- Repository constraint:
  - Repository is initialized with Git (`main`).
  - Use feature branches/worktrees when splitting larger parallel tracks (GUI, extraction, evaluation).

## Delivery Plan
1. Add a generation module for CCv3 cards + lorebook memories.
   - Consume sampled conversation exports (`model_exports/<model>/*.jsonl`).
   - Build compact transcript packets for analysis.
   - Support local/open-source backends (starting with Ollama/OpenAI-compatible HTTP endpoints).
   - Emit strict Character Card V3 JSON and `lorebook_v3` JSON.
2. Add a simple Gradio GUI for non-technical users.
   - Step A: Select ZIP or `conversations.json`.
   - Step B: Analyze/list models and extract selected model conversations.
   - Step C: Build fine-tune dataset JSONL.
   - Step D: Generate CCv3 card + lorebook memories from sampled conversations.
   - Step E: Download outputs from a single run directory.
3. Add safety and quality controls.
   - Sampling controls (`max conversations`, `max chars per convo`) for token budget.
   - Structured JSON validation/fallback cleanup.
   - Explicit status/progress in UI.
4. Verify with smoke tests.
   - Python syntax compile checks.
   - Small-sample run from existing local exports.
5. Add fidelity benchmark stage.
   - Evaluate up to 5 candidate models against transcript-derived style profile.
   - Optional LLM judge pass for rubric-based fidelity scoring.

## Prompt Strategy (CCv3 + Lorebook)
- Use two specialized extraction passes instead of one generic pass:
  - Persona pass: reconstruct stable companion identity, voice, cadence, and relational contract.
  - Memory pass: extract high-signal shared memories only.
- Memory pass follows strict quality filtering inspired by Omi prompt design:
  - Prefer durable, specific, user-relevant memories.
  - Exclude trivial chatter, temporal logistics, and low-signal duplication.
  - Keep entries concise and triggerable via practical `keys`.
- Critical constraint:
  - Prompts are extraction-only. They must not shape or optimize personality beyond what transcript evidence supports.

## Provider Support
- Generation and evaluation now support:
  - `ollama`
  - `openai`
  - `openrouter`
  - `anthropic`

## Active Implementation Plan (Updated 2026-02-06)
1. Stabilize GUI state + model workflow for non-technical users.
   - Keep one shared settings page for provider/API key/model discovery.
   - Persist selected preset/model and generation settings across refresh.
2. Improve extraction robustness for large archives.
   - Add retry/backoff handling for transient provider overload/rate-limit errors.
   - Use context-window-aware budget presets (`64k/128k/200k/1M/auto`).
3. Add explicit file-scope control and auditability.
   - Separate personality sampling scope from memory scope (`memory_sample_conversations`, with `0 = all files`).
   - Write per-run source file lists and a `processing_manifest.json` with selected files and stats.
4. Improve memory quality and deduplication.
   - Compact near-duplicate memories before lorebook emission.
   - Preserve strongest variant and merged keys for repeated facts.
5. Improve review/edit loop for normie UX.
   - Render character card and lorebook JSON in editable text areas, not download-only.
   - Save edited JSON back to generated files from within the app.
6. Maintain evaluation path for personality fidelity.
   - Test up to 5 candidate models and compare style/tone/cadence fidelity reports.

## Status Snapshot (2026-02-06)
- Completed:
  - Added retry/backoff for transient provider overload and rate-limit failures in LLM extraction.
  - Added context-aware extraction flow with staged per-conversation persona/memory passes plus synthesis.
  - Added separate memory scope control (`memory_sample_conversations`) so memory extraction can use a different file set than persona extraction.
  - Added per-run provenance artifacts: `persona_sources.txt`, `memory_sources.txt`, and `processing_manifest.json`.
  - Added memory compaction for duplicate/near-duplicate lorebook facts (including normalized birthday signatures).
  - Added editable card/lorebook JSON panes in GUI with explicit save actions.
  - Fixed GUI callback/state wiring issues that caused intermittent generic `error` responses.
- Current behavior:
  - `python app.py` launches LAN-accessible by default (`0.0.0.0:7860`).
  - Background lifecycle scripts remain available in `scripts/`.
  - Generation report includes sampling metadata, processed file lists, and memory compaction counts.
- Next priorities:
  - Improve personality extraction quality on larger/randomized samples with better synthesis constraints.
  - Add clearer runtime progress metrics (estimated total LLM calls and per-stage ETA hints).
  - Expand fidelity benchmark presets and baseline comparisons across candidate open models.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
