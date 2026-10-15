# indicator_match stage

Checks one evidence item's current facts against one registered indicator set
(EPOCH-491). It reads the set the orchestrator chose (`--indicator-set-id`),
not a derivative, and the facts through the
[indicator field map](../../../docs/indicator-field-map.md). How matching
works, how a check is identified and what its summary says are in
[evidence-model.md](../../../docs/evidence-model.md#derivatives).

- `matching.py`: what matches, with no database: reading facts through the
  field map, normalizing, matching, and the per-type summary.
- `match_stage.py`: the database reads and the one ingest unit; `main.py` is
  the entrypoint.

## Test

```bash
uv run pytest apps/extractors/indicator_match
```

`test_stage.py` needs `TEST_DATABASE_URL` (real Postgres).
