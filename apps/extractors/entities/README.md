# entities stage

Reads what one evidence's records mention, by kind: domains, URLs, apps,
processes, email addresses, phone numbers, IP addresses, Wi-Fi networks and
access points, and Bluetooth devices (EPOCH-581). Each value is read from a
named field by a rule in
[`entity_rules.json`](../../../packages/contracts/entity_rules.json), never
from its shape alone. How entities are stored and read is in
[evidence-model.md](../../../docs/evidence-model.md#entities).

The rules contract also records reviewed iLEAPP headers that deliberately have
no entity rule. Those exclusions do not suppress field-coverage reporting: a
populated excluded field remains visible as unread in the unit summary.
For VER-291, VER-288, and the browser and network/connectivity families of
VER-284, the contract names the reviewed Apple-native app, Biome, browser, and
network artifacts against the pinned iLEAPP source. Tests require every
declared header in those artifacts to have exactly one rule or a reasoned
exclusion. The contract's `deferred_location_headers` identifies exact location fields
in mixed Wi-Fi artifacts assigned to
[VER-306](https://linear.app/verichron-epoch/issue/VER-306/review-remaining-location-data-coverage-across-artifact-families).
`deferred_location_sources` records the pinned iLEAPP modules that emit those
artifacts.
Existing connectivity rules, including SSID and BSSID rules in those
artifacts, remain in VER-284; connection/association timestamps also remain
connectivity decisions. Only the specific location headers listed in the
contract are assigned to VER-306; deferrals do not exclude a whole artifact
or family. Photos/iCloud and communications/social families remain assigned
to other review batches. The four VER-282 research fields are explicitly
reserved and do not gain rules from these reviews. VER-288 includes the
pinned Biome-category Photos Search Insights stream; this does not bring the
Photos/iCloud artifact family into scope.

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
