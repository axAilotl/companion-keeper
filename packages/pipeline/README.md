# Pipeline (Node/TypeScript)

Memory-safe extraction pipeline for large OpenAI and Anthropic chat exports.

## Features
- Streams top-level JSON arrays without loading full files into memory.
- Supports both raw `conversations.json` paths and ZIP paths containing `conversations.json`.
- Discovers assistant models and extracts per-conversation JSONL/JSON files under `model_exports/<model>/`.
- Includes generation payload builders and card/lorebook shaping helpers for future LLM calls.

## CLI
```bash
# List models
node dist/cli.js --input conversations.json --list-models

# Extract selected models
node dist/cli.js \
  --input conversations.json \
  --extract \
  --models gpt-4o,gpt-4o-mini \
  --output-dir model_exports
```

## Development
```bash
pnpm install
pnpm --filter @gptdataexport/pipeline build
pnpm --filter @gptdataexport/pipeline test
```
