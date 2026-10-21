# indicator_match stage

Checks one evidence item's current entities against one registered indicator
set (EPOCH-491, EPOCH-581). It reads the set the orchestrator chose
(`--indicator-set-id`), not a derivative, and compares it with the entities
the entities stage read, kind by kind, as
[indicator types](../../../docs/indicator-types.md) declares. How matching
works, how a check is identified and what its summary says are in
[evidence-model.md](../../../docs/evidence-model.md#derivatives).

- `matching.py`: what matches, with no database: comparing entities with
  indicators, and the per-type summary.
- `match_stage.py`: the database reads and the one ingest unit; `main.py` is
  the entrypoint.

## Test

```bash
uv run pytest apps/extractors/indicator_match
```

`test_stage.py` needs `TEST_DATABASE_URL` (real Postgres). It runs the
entities stage itself to write the entities a check reads.
