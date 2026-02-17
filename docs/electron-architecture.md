# Electron Architecture

## Workspace layout

- `apps/desktop`: Electron main and preload processes.
- `apps/renderer`: React + Vite renderer UI.
- `packages/pipeline`: Node TypeScript streaming import/extract/generation helpers.
- `packages/shared`: Runtime-safe IPC contracts and shared TypeScript types.

The root workspace uses `pnpm` workspaces and `turbo` task orchestration.

## Process boundaries

- Main process (`apps/desktop/src/main.ts`):
  - owns filesystem access and app lifecycle
  - initializes app data directories under Electron `userData`
  - registers IPC handlers for app paths, job controls, and pipeline actions
  - calls `@gptdataexport/pipeline` for model discovery, extraction, and draft shaping
  - broadcasts job status events over a dedicated event channel
- Preload (`apps/desktop/src/preload.ts`):
  - exposes `window.desktopApi` for job channels
  - exposes `window.rendererBridge` and `window.electronAPI.invoke` for renderer workflow calls
  - validates outgoing requests and incoming responses with Zod-backed shared schemas
  - subscribes to job event channel and validates each payload
- Renderer (`apps/renderer`):
  - consumes typed bridge contracts from `@gptdataexport/shared`
  - calls `window.rendererBridge` first, then `window.electronAPI.invoke`
  - cannot access Node APIs directly (`contextIsolation: true`, `sandbox: false`, `nodeIntegration: false`)

## IPC contract model

All IPC channel names, request/response schemas, and event schemas live in
`packages/shared/src/ipc.ts`.

Main and preload both call:

- `parseIpcInvokeRequest(channel, payload)`
- `parseIpcInvokeResponse(channel, payload)`
- `parseJobEvent(payload)`

This keeps message shape validation symmetric on both sides.

## IPC channels

Invoke channels:

- `app:get-paths`
- `jobs:start`
- `jobs:cancel`
- `jobs:list`
- `pipeline:import-file`
- `pipeline:analyze-models`
- `pipeline:extract-and-generate`
- `pipeline:save-review`

Event channels:

- `jobs:event`

## Run and verify

From repo root:

- `pnpm install`
- `pnpm dev` (renderer + desktop together)
- `pnpm dev:renderer`
- `pnpm dev:desktop`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
