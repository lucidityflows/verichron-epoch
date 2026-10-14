# crash stage

Parses iOS `.ips` crash and analytics files into `crash_report` facts, one per
file. Order 10; it reads the **device's crash logs** (the `crash_reports`
derivative). It follows the
[stage contract](../../../packages/contracts/EXTRACTOR_CONTRACT.md).

**Source (EPOCH-447).** An iOS backup holds none of the device's crash logs:
on the real reference backup, `Manifest.db` listed no file under
`DiagnosticReports` or `CrashReporter`. Crash logs are copied from the device
separately: EPOCH-514 adds this to the iPhone pull, and EPOCH-515 reads them
from full-filesystem extractions. Until one of those has produced crash logs
for the evidence, the orchestrator records this stage as skipped, with that
reason, and the report lists it under Not Examined. The stage never searches a
backup for crash logs.

## Parsing

Every `.ips` file copied from the reference device (230, EPOCH-447) starts with
a JSON metadata line (`bug_type`, `timestamp`, `os_version`, `incident_id`).
`parse_ips_file` requires it; a file without one fails and stays retryable.
What follows depends on the bug type, and is kept exactly whatever its format
(`body_format`):

- `json`: a JSON document (212 of the 230), read for the fields below;
- `text`: a text report, such as `Date/Time: ...` or `Message Group: ...` (16);
- `binary`: bytes that aren't UTF-8 (2), stored encoded (`stored_value`,
  EPOCH-502).

The whole parsed file is kept as the payload (`full`): `metadata`,
`body_format` and `body`. A text or binary body's record comes from the
metadata line. The device's other diagnostic files (`.ca`, `.session`, `.log`)
aren't read; the stage's notes count them by extension.

Top-level columns:

- `incident_id`
- `event_time`, from the metadata line's `timestamp`, which every file has;
  null if it can't be parsed (R11). A JSON body's own `captureTime` or `date`,
  where there is one, is kept in `fields.body_time`: on every real file that
  has both, the two agree to within a second
- `bug_type`, `process_name`, `pid`, `bundle_id`

`fields` holds the rest:

```json
{
  "filename": "...", "body_format": "json", "time_source": "metadata timestamp",
  "body_time": "...", "os_version": "...", "hardware_model": "...", "cpu_type": "...",
  "bundle_version": "...", "parent_proc": "...", "parent_pid": 1, "proc_launch": "...",
  "proc_path": "...", "proc_role": "...", "time_awake_since_boot": 5000,
  "exception": { "type": "...", "signal": "...", "code": "...", "subcode": "..." },
  "termination": { "namespace": "...", "code": 6, "by": "..." },
  "faulting_thread": 0, "is_simulated": false, "is_non_fatal": false,
  "asi": ["..."], "vm_region_info": "..."
}
```

Nothing is decoded lossily: the metadata line must be valid UTF-8 JSON, and a
body that isn't UTF-8 is kept as bytes, so no byte is ever dropped.

The field mapping was worked out from real samples. Apple publishes no format
spec, so a new iOS version may leave some fields null rather than raise an error.
The tests use redacted real reports, one per body format
([fixtures/README.md](fixtures/README.md)).

Failures are handled per file: an unparseable file is rolled back and retried on
the next run, while the others commit. The atomicity tests are in
`scripts/test_extractor_ingest_atomicity.py`.
