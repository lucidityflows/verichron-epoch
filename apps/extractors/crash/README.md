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

`parse_ips_file` reads both `.ips` shapes: a metadata line followed by a JSON
body, or a single JSON document. `extract_rich_telemetry` pulls out the useful
fields. The whole parsed document is kept as the payload (`full`).

Top-level columns:

- `incident_id`
- `event_time`, from `captureTime` or `date`; null if unparseable
- `bug_type`, `process_name`, `pid`, `bundle_id`

`fields` holds the rest:

```json
{
  "filename": "...", "os_version": "...", "hardware_model": "...", "cpu_type": "...",
  "bundle_version": "...", "parent_proc": "...", "parent_pid": 1, "proc_launch": "...",
  "proc_path": "...", "proc_role": "...", "time_awake_since_boot": 5000,
  "exception": { "type": "...", "signal": "...", "code": "...", "subcode": "..." },
  "termination": { "namespace": "...", "code": 6, "by": "..." },
  "faulting_thread": 0, "is_simulated": false, "is_non_fatal": false,
  "asi": ["..."], "vm_region_info": "..."
}
```

Files are decoded as strict UTF-8: a file with an undecodable byte fails and
stays retryable, rather than losing bytes silently.

The field mapping was worked out from real samples. Apple publishes no format
spec, so a new iOS version may leave some fields null rather than raise an error.

Failures are handled per file: an unparseable file is rolled back and retried on
the next run, while the others commit. The atomicity tests are in
`scripts/test_extractor_ingest_atomicity.py`.
