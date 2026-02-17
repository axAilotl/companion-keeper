# Renderer UI (Electron)

This app is a renderer-only React + TypeScript + Vite surface for the companion preservation flow.

## UX Flow

1. `Import Data` tab: import export, discover models, split to JSONL cache
2. `Recover Persona` tab: recover card + lorebook from selected model cache
3. `Edit Persona` tab: edit card/lore, upload persona image, save and export persona package
4. `Fidelity Test` tab: run model scoring against edited persona/lore
5. `Settings` tab: all defaults and API key fields in one place

## Backend Integration

- The renderer uses typed contracts imported from `@gptdataexport/shared`.
- `tsconfig` resolves this to the shared workspace source for local development.
- Runtime calls try `window.rendererBridge` first, then `window.electronAPI.invoke`.

## Commands

```bash
pnpm install
pnpm --filter @gptdataexport/renderer dev
pnpm --filter @gptdataexport/renderer typecheck
pnpm --filter @gptdataexport/renderer test
pnpm --filter @gptdataexport/renderer build
```
