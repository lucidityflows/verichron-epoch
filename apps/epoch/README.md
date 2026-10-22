# Epoch desktop app (`@verichron/epoch`)

The Electron app examiners use to:

- pull an encrypted backup from a connected device;
- run the processor and the orchestrator;
- browse runs, records, IOC detections and reports.

It reads the database through [`@verichron/etl-db-reader`](../../packages/etl-db-reader)
and never writes facts or decides run state. Completeness comes from the
`run_completeness` view (R23).

## Run

```bash
pnpm --filter @verichron/epoch dev          # development
pnpm --filter @verichron/epoch make         # package installers (electron-forge)
```

The app loads the repository's `.env` for the database connection.

## Structure

| Path | Contents |
|---|---|
| `src/main/` | Main process: IPC handlers (`ipc/`), device-backup tooling (`tools/device-backup/`), spawning the processor and the orchestrator |
| `src/preload/` | The `window.epoch` bridge exposed to the renderer |
| `src/renderer/` | React UI: `views/`, `features/`, `components/ui/` (shared primitives), `store/` (Zustand), `hooks/`, `api/` |
| `src/shared/` | Types shared by the main process and the renderer |

IPC invoke arguments and results, event payloads, and the exposed bridge are
defined together in `src/shared/ipc/channels.ts` (R2). Main-process handlers
and event sends use the typed helpers in `src/main/ipc/typedIpc.ts`; the
preload exposes only the generic `invoke` and `on` bridge, which renderer APIs
wrap for application features.

Visual design follows [DESIGN.md](DESIGN.md).

**Known issues:**

None currently tracked here.
