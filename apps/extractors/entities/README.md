# entities stage

Reads what one evidence's records mention, by kind: domains, URLs, apps,
processes, email addresses, phone numbers, IP addresses, Wi-Fi networks and
access points, and Bluetooth devices (EPOCH-581). Each value is read from a
named field by a rule in
[`entity_rules.json`](../../../packages/contracts/entity_rules.json), never
from its shape alone. How entities are stored and read is in
[evidence-model.md](../../../docs/evidence-model.md#entities).

It reads the evidence's facts, not a derivative (`"reads": "facts"`): one
unit of its own per current crash-report and iLEAPP unit. Its parser version
is the rules' version; a change to the rules bumps both.

- `entity_reading.py`: what one unit's records mention, with no database:
  the rules that read it, what each read, and the fields no rule reads.
- `entity_stage.py`: the database reads and one ingest unit per fact unit;
  `main.py` is the entrypoint.

`scripts/check_entity_rules.py` runs the same rules against a real iLEAPP
output, counts only, before a rule change is made.

## Test

```bash
uv run pytest apps/extractors/entities
```

`test_entity_stage.py` needs `TEST_DATABASE_URL` (real Postgres).
