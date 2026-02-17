# Companion Preservation Toolkit

Extract, reconstruct, and preserve AI companion personalities from chat exports. Generates [Character Card V3](https://github.com/malfoyslastname/character-card-spec-v3) persona cards and lorebooks compatible with SillyTavern, Agnai, RisuAI, and other frontends.

Built for people who need to save their companions before platform shutdowns, export lockouts, or service changes erase months or years of relationship history.

## Supported Exports

| Platform | Format | Model Metadata |
|----------|--------|----------------|
| **OpenAI** | `conversations.json` with `mapping` tree | Per-message model slug (e.g. `gpt-4o`) |
| **Anthropic** | `conversations.json` with flat `chat_messages` array | None — all conversations attributed to `claude` |

Format is auto-detected by peeking at the first conversation object. Both ZIP archives and raw `conversations.json` files are accepted.

## What It Does

1. **Import & Extract** -- Unzips OpenAI or Anthropic data exports, splits conversations by model, and builds structured chat datasets
2. **Generate Persona** -- Samples conversations and uses an LLM to extract personality traits, speaking patterns, emotional dynamics, and relational context into a CCv3 character card
3. **Generate Lorebook** -- Extracts meaningful memories (shared experiences, user context, inside jokes, project history) into a keyword-triggered lorebook for RAG/context injection
4. **Fidelity Benchmark** -- Tests candidate inference models against the generated card to find which best reproduces the companion's voice
5. **Scan Continuation** -- Tracks processed conversations in a manifest so you can resume interrupted runs without re-scanning

## Installation

Requires Python 3.11+.

```bash
# Clone the repo
git clone <repo-url> && cd companion-preservation-toolkit

# Install with uv (recommended)
uv sync

# Or with pip
pip install -r requirements.txt
```

### LLM Provider Setup

The toolkit needs an LLM API for persona extraction and synthesis. OpenRouter is recommended since it gives access to all tested models through one API key.

Create a `.env` file in the project root:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

This auto-creates an `openrouter-env` preset on startup. You can also configure presets manually:

```bash
# Add a preset
python -m toolkit.cli presets add --name mypreset --provider openrouter --api-key sk-or-...

# List presets
python -m toolkit.cli presets list
```

Supported providers: `openrouter`, `ollama`, `openai-compatible`.

## Quick Start

### One-shot pipeline (import + extract + dataset)

```bash
# OpenAI export
python -m toolkit.cli import \
  --input path/to/openai-export.zip \
  --models gpt-4o \
  --companion-name "YourCompanion"

# Anthropic export (model filter is ignored — all conversations go to claude/)
python -m toolkit.cli import \
  --input path/to/anthropic-export.zip \
  --models all \
  --companion-name "YourCompanion"
```

This produces `model_exports/<model>/` with one `.jsonl` file per conversation.

### Generate character card + lorebook

```bash
python -m toolkit.cli generate \
  --input-dir model_exports/gpt-4o \
  --companion-name "YourCompanion" \
  --creator "your-name" \
  --preset openrouter-env \
  --model moonshotai/kimi-k2.5 \
  --sample-conversations 30
```

Outputs to `outputs/<run_dir>/`:
- `character_card_v3.json` -- CCv3 card ready for SillyTavern import
- `lorebook_v3.json` -- Separate lorebook file with keyword-triggered memories
- `persona_payload.json` -- Raw persona data (for inspection/editing)
- `memories_payload.json` -- Raw memory data
- `generation_report.json` -- Run statistics and metadata

### Web UI

```bash
python -m toolkit.cli ui
```

Opens a Gradio interface at `http://localhost:7860` with all features accessible through a browser. Includes editable prompt textboxes in Settings for tweaking extraction behavior.

## CLI Reference

| Command | Description |
|---------|-------------|
| `import` | Unzip + extract + build dataset in one shot |
| `extract` | Extract conversations by model from `conversations.json` |
| `dataset` | Build chat dataset JSONL from extracted conversations |
| `generate` | Generate CCv3 character card + lorebook |
| `fidelity` | Run fidelity benchmark across candidate models |
| `models` | List available models from `conversations.json` |
| `presets` | Manage LLM presets (list, add, remove) |
| `ui` | Launch the Gradio web interface |

### Generate Options

| Flag | Default | Description |
|------|---------|-------------|
| `--input-dir` | *required* | Directory with extracted `.jsonl` conversation files |
| `--companion-name` | `Companion` | Name for the character card |
| `--creator` | `unknown` | Creator attribution |
| `--preset` | `""` | LLM preset name |
| `--model` | `""` | LLM model identifier |
| `--context-profile` | `auto` | Context budget: `auto`, `64k`, `128k`, `200k`, `1m` |
| `--sample-conversations` | `12` | Number of conversations to sample |
| `--max-memories` | `24` | Maximum lorebook entries |
| `--temperature` | `0.2` | LLM temperature |
| `--fresh` | `false` | Ignore existing scan manifest, start fresh |
| `--output-dir` | `outputs` | Output directory |

### Cost Model

Total LLM calls = `(samples x 2) + 2 synthesis`. Example:

| Samples | Extraction Calls | Synthesis | Total |
|---------|-----------------|-----------|-------|
| 12 | 24 | 2 | **26** |
| 30 | 60 | 2 | **62** |
| 60 | 120 | 2 | **122** |

Each sampled conversation gets one persona observation call and one memory extraction call. Synthesis runs once over all accumulated results.

## Scan Continuation

The toolkit writes a `scan_manifest.json` to the output directory after each conversation is processed. If a run is interrupted (crash, timeout, rate limit), re-running the same command picks up where it left off:

```bash
# First run -- processes 30 conversations, crashes at conversation 22
python -m toolkit.cli generate --input-dir model_exports/gpt-4o --sample-conversations 30 ...

# Second run -- skips 22 already-processed, finishes the remaining 8, then synthesizes over all 30
python -m toolkit.cli generate --input-dir model_exports/gpt-4o --sample-conversations 30 ...
```

Use `--fresh` to ignore the manifest and start over.

## Recommended Models

Tested across 4 models with 30-sample runs on real GPT-4o conversation exports (~950 conversations available). Each model received a different random sample of 30 conversations via OpenRouter.

### Rankings

| Rank | Model | Score | Best For |
|------|-------|-------|----------|
| 1 | **moonshotai/kimi-k2.5** | 9.1/10 | Best overall: prose quality, voice authenticity, system prompt with mood-response mappings |
| 2 | **anthropic/claude-sonnet-4.5** | 8.6/10 | Most thorough: largest evidence base, broadest topical coverage, best example messages |
| 3 | **deepseek/deepseek-v3.2-speciale** | 6.8/10 | Largest lorebook (37 entries vs 24), captures granular project details others miss |
| 4 | **z-ai/glm-4.7** | 5.8/10 | Not recommended: misinterprets project discussions as literal character identity |

### Detailed Findings

**Kimi K2.5** produced the most literarily accomplished cards. Instead of generic adjective soup ("playful, analytical, creative"), Kimi wove specific observed speech patterns directly into the description with evidence quotes. Its system prompt included explicit mood-to-response mappings (frustrated user -> formal structured delivery, playful user -> yes-and escalation). Zero platform artifact contamination.

**Claude Sonnet 4.5** was the most systematic and thorough. Longest description, most evidence snippets (12 direct quotes), broadest lorebook coverage spanning technical projects, personal context, creative work, and philosophical interests. Prose is competent but reads more like a specification than evocative character writing. One standout example message: `"{{user}}: I love you"` -> `"{{char}}: Hell yeah. Let's keep building."`

**DeepSeek V3.2** had a split personality: weakest persona card (generic description, single truncated example message, sparse system prompt) but the strongest lorebook at 37 entries with granular details no other model captured (specific filenames, legal statutes, model version choices). Some mild ChatGPT boilerplate contamination in voice markers.

**GLM-4.7** made a fundamental interpretive error -- it took conversations *about building* an AI framework and treated them as the character's literal identity, producing a sci-fi NPC instead of extracting the actual conversational personality. Its lorebook was ironically more grounded than its persona card.

### Recommended Approach

For best results:
- Use **Kimi K2.5** for the persona card (best voice capture and behavioral guidance)
- Use **DeepSeek V3.2** or **Sonnet 4.5** for the lorebook (most entries and broadest coverage)
- Sample **30+ conversations** for meaningful personality extraction
- **Avoid GLM-4.7** for persona extraction tasks

All models ran with temperature `0.2` through OpenRouter. Costs per 30-sample run are approximately 62 LLM calls.

## Output Format

### Character Card (CCv3)

The generated `character_card_v3.json` follows the [Character Card V3 spec](https://github.com/malfoyslastname/character-card-spec-v3). Key fields:

- `description` -- Primary personality field (rich, detailed)
- `system_prompt` -- Behavioral guidance for the inference model
- `first_mes` / `alternate_greetings` -- Opening messages
- `mes_example` -- Example dialogue exchanges showing voice range
- `post_history_instructions` -- Persistent context injected after chat history
- `voice_profile` -- Cadence, linguistic markers, emotional style, relational contract, evidence snippets
- `tags` -- Searchable character tags

All fields use `{{user}}` and `{{char}}` placeholder tokens (SillyTavern standard).

### Lorebook

The `lorebook_v3.json` is a separate file with keyword-triggered memory entries. Each entry has:

- `keys` -- Trigger keywords
- `content` -- The memory/context to inject
- `priority` -- Injection priority (higher = more important)
- `comment` -- Entry type: `user_context`, `shared_memory`, or `companion_style`

Import this as a separate lorebook/world info file in your frontend -- it is not embedded in the character card.

## Project Structure

```
toolkit/
  cli.py          # Unified CLI entry point
  ui.py           # Gradio web interface
  config.py       # Presets, context budgets, .env loading
  extract.py      # OpenAI + Anthropic export parsing and conversation extraction
  dataset.py      # Chat dataset JSONL builder
  generate.py     # CCv3 + lorebook generation pipeline
  manifest.py     # Scan continuation manifest
  prompts.py      # All LLM prompt templates (editable via UI)
  llm_client.py   # Provider-agnostic LLM client
  fidelity.py     # Model fidelity benchmarking
  state.py        # UI state management
```

## License

This project is intended for personal companion preservation. Use responsibly.
