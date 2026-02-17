# BEADS Tracker (Fallback)

`beads` skill/tool is not available in this environment, so this file tracks feature beads manually.

## Beads

- `B-001` Electron workspace foundation
  - status: `in_progress`
  - owner: `feat/electron-foundation`
  - scope: root workspace config, desktop main/preload, shared IPC schemas

- `B-002` Node streaming pipeline port
  - status: `in_progress`
  - owner: `feat/node-pipeline`
  - scope: streaming import/discovery/extract APIs + CLI + tests

- `B-003` Renderer UX (desktop-first)
  - status: `in_progress`
  - owner: `feat/electron-ui`
  - scope: import/analyze/extract-generate/review UI with stable large-text handling

- `B-004` Integration and bootstrap
  - status: `pending`
  - owner: `main`
  - scope: merge branches, wire IPC to pipeline, add run docs, smoke checks

## Risks

- Root workspace config conflicts during merge.
- IPC contract drift between desktop/shared/renderer packages.
- Large export parsing regressions if stream boundaries are mishandled.

## Acceptance Targets

- App starts via a single desktop command.
- Large export handling is streamed and does not block renderer.
- Review/edit fields preserve multiline formatting.
- Memory list load/edit is paginated or virtualized and stable.
