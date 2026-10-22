# Database server (`@verichron/dbserver`)

The Lab bundle's own PostgreSQL 17 (EPOCH-477; [architecture](../../docs/architecture.md#the-lab-bundle)).
It runs only from the bundle; a checkout keeps its development database (Docker
and `.env`).

```bash
node services/dbserver.mjs ensure   # start it, creating the database on the first start
node services/dbserver.mjs stop     # stop it, if it runs
```

The app runs `ensure` before it opens its window and gives every service it
starts the printed address as `DATABASE_URL`; it runs `stop` when it quits.

- **Where:** the data under `$XDG_DATA_HOME/verichron-epoch/postgresql/`
  (default `~/.local/share/`), the socket under `$XDG_RUNTIME_DIR/verichron-epoch/`.
  Without `XDG_RUNTIME_DIR` it refuses, rather than guess where a private socket
  could go.
- **Who connects:** local peer connections only, no TCP and no password. The
  examiner's OS account maps to two roles: `verichron_epoch_admin` (initdb's
  superuser: migrations and provisioning) and `epoch_app` (the runtime login,
  holding only `verichron_epoch_runtime`).
- **First start:** initdb, the database, every migration, then the runtime login
  (`provision_roles.py --peer`). A marker beside the data directory records that
  it finished; a first start that stopped part-way is refused, with how to start
  again.
- **Later starts:** the same database, used only when it is fully migrated. A
  database behind this version is refused until upgrades exist (EPOCH-475).
- **One at a time:** `ensure` and `stop` take the workspace lock
  (`@verichron/workspace-lock`) on `$XDG_DATA_HOME/verichron-epoch/`. An
  overlapping call waits, up to five minutes, then finds the server the first
  one started; so of two overlapping starts, neither stops the server the
  other started.
- **A failed start leaves no server running:** a server this call started is
  stopped when a later step fails, and one left on an unfinished database is
  stopped before its removal is advised.

Checked from a moved bundle by `tools/services/check.sh`.
