# Evidence model

How Verichron Epoch identifies evidence, what it derives from it, and how a fact
stays traceable to its source. The components named here are described in
[architecture.md](architecture.md).

## Evidence

**Evidence is identified by its content, not its location (R6).** The processor
hashes every file of a backup into a *canonical manifest*:

- one line per file: `<sha256>  <path>`;
- paths are relative, NFC-normalized and `/`-separated;
- lines are sorted by the path's UTF-8 bytes.

The evidence's `content_root` is the sha256 of that manifest. The same backup
mounted at two paths, or on two machines, is one piece of evidence with two
*locations*. Renaming a file inside the backup changes the identity; moving the
whole backup does not. Byte-identical files from two devices are still two
pieces of evidence: nothing is deduplicated across evidence.

The manifest is stored content-addressed (`manifests/<root>.sha256`) and never
overwritten. The sidecar pointing at it is replaced atomically, and only once
its manifest exists, so a crash can never leave a sidecar naming a missing
manifest.

**Devices.** A device is keyed by `HMAC-SHA256(UDID, per-install secret)`, with
a user-editable label. The raw UDID is never stored, so the same phone matches
across backups without its identifier leaking into the database, the UI or
reports. The secret lives in `~/.config/verichron/device-key.secret` (mode 0600;
a copy other users can read is refused). The UDID is read from `Info.plist`'s
`Unique Identifier` / `Target Identifier`; `GUID` is an iTunes backup ID, not the
UDID, and is refused.

## Derivatives

A *derivative* is something produced from evidence: the **decrypted** backup,
and, made from it with the decrypt as its parent, **iLEAPP's output**
(`ileapp_output`). Facts are filed under the
derivative they were read from, so iLEAPP records belong to iLEAPP's output, not
to the decrypt (R7).

The device's **crash logs** (`crash_reports`) are a third kind. An iOS backup
holds none of them (verified on a real backup, EPOCH-447): they are copied from
the device separately (EPOCH-514).

- **Acquired by the pull.** After a completed backup, the pull runs
  `idevicecrashreport -k`, which copies the reports and leaves them on the
  device, into `<UDID>.crash-reports/` beside the backup, never inside it, so
  the backup's content root is the device's backup alone. Only a finished copy
  gets `<UDID>.crash-reports.json`: the tool, when, and the file and byte
  counts. The pull record says what the copy did; a failed copy doesn't fail
  the completed backup.
- **Copied by the processor.** It copies them into
  `<workspace>/crash_reports/<label>/`, hashes the copy the way a backup is
  hashed, and writes `.crash_reports_ok` once the copy matches the pull's
  folder. A folder without the pull's record, or one that changed after the
  pull, is not used.
- **Registered with the backup's evidence, with no parent.** They were acquired
  in the same pull, not derived from the backup. Their identity is the tool and
  their content root; when they were copied is recorded but is not part of it.

Full-filesystem extractions will provide them too (EPOCH-515). A stage that
reads a derivative the evidence lacks normally fails; for crash logs, whose
absence is a fact about how the evidence was acquired, the stage is recorded as
skipped with that reason, and the report lists it under Not Examined.

A derivative's identity is **(evidence, kind, parent, provenance)**:

- **provenance** is the tool that made it and the parameters that shaped it, for
  example:
  - a decrypt records the decrypt library and its version
    (`iphone_backup_decrypt`, EPOCH-489) and the SQLite repair outcome (sqlite3
    version, databases repaired, files not fully recovered, originals kept as
    `.corrupt-<timestamp>`);
  - iLEAPP's output records the iLEAPP commit (the submodule's, because
    iLEAPP's self-reported version does not match its release tag) and how
    iLEAPP read the decrypt (`itunes` or `fs`);
- `provenance_key` is the sha256 of that provenance in canonical form, with
  each preserved original counted as the database it came from: when a copy
  was set aside shaped nothing, so a repeated decrypt with the same repair
  outcome is the same derivative (EPOCH-517);
- a different tool version, repair outcome or iLEAPP commit is
  therefore a **new derivative**. A derivative's identity is never rewritten.
  Its path, its last-known location, is updated, and a repeated pass refreshes
  the preserved originals' names to the files that exist now.

**Completion markers.** The processor writes `.decrypted_ok` and `.ileapp_ok`
only once a derivative is finished. A decrypt is finished only when every file
the backup's `Manifest.db` lists was written. Each records the evidence `content_root` it
was made from and its provenance. Registration refuses a derivative whose marker
is missing, malformed, or names different evidence. That's how a backup that
changed under the same label can never have its old decrypt filed under the new
evidence.

**iLEAPP's module outcomes are part of its output's provenance** (EPOCH-457).
iLEAPP runs each plugin in its own `try`/`except` and still exits 0 when one
errors, so the processor reads the `modules` list from `_lava_data.lava` and
records it in `.ileapp_ok`: how many modules completed, the artifacts with no
files in the backup, and each plugin that errored (module, artifact, file count
and iLEAPP's logged error). An output without a readable module list gets no
marker. The report states every error under "Not Examined", and the counts
under "Coverage". A plugin error doesn't fail the stage: it fails the same way
on every run, so no retry can get past it.

**Indicator sets.** No derivative records an indicator set at the moment:
indicator checks were removed with their tool (EPOCH-489). Indicator sets return
as versioned, hashed data the project's own matching reads (EPOCH-490, 491).

## Runs

A *run* is one invocation of the pipeline over one piece of evidence. **A run is
an audit event; facts belong to evidence, not to runs (R7).**

- Every rerun creates a new run; finished runs are never reopened.
- Each stage's row records its status, times, the parser version it ran at and
  the derivative it read. A failed stage's stderr is its `error_message`; a
  succeeded stage's stderr is its `warnings` (EPOCH-420), which never change
  the run's state.
- **Completeness has one definition (R23):** the `run_completeness` view. A run
  is `running` until it finishes; `incomplete` if any stage failed or was left
  pending or running; otherwise `complete`. A `skipped` (disabled) stage never
  makes a run incomplete. Nothing else may re-derive this.
- **Resume.** Evidence is skipped only if a complete run already ran every stage
  enabled now, at the parser version declared now, against the derivative it
  would read now. A parser version bump, a newly enabled stage, a new results
  set or new iLEAPP output therefore gets a new run.

## Facts and the ledger

Every fact enters through one door, `ingest()` in `db_writer.py` (R13).

- **The unit is one source file:** `(evidence, file_hash, source_type,
  parser_version)` (R6). A file's ledger row, payload and records commit together
  or not at all (R13, R14). A failed unit leaves no trace, so the next run
  retries it. When the unit is one part of a file, `file_hash` is a sha256 over
  that part's content instead: each iLEAPP artifact table in
  `_lava_artifacts.db` is its own unit (EPOCH-461).
- **Identity comes from context (R16).** The orchestrator passes evidence,
  derivative, run and parser version, and the writer stamps them. A stage never
  supplies them.
- **Each unit declares its payload** (R12): `full`, `summary` or `none`.
- **Versions are append-only (R8).** Bumping a stage's `parserVersion` re-ingests
  each file as a new unit beside the old one.
- **A value PostgreSQL can't hold is stored encoded, never altered** (EPOCH-502).
  `jsonb` rejects NUL (U+0000), and JSON has no binary, so such a value is kept
  exactly as `{"$encoded": "<encoding>", "value": "<hex>"}`: `hex` for binary
  (decode to bytes) and `utf8-hex` for text holding NUL (decode the bytes as
  UTF-8). JSON has no infinity either, so an infinite number is kept as
  `{"$encoded": "float", "value": "Infinity" | "-Infinity"}` (EPOCH-418).
  Any other value is stored as it is. The convention has one implementation,
  `stored_value` in `packages/contracts/python/`, which every stage uses (the
  iLEAPP bridge for column values, the crash stage for a report body that
  isn't UTF-8 text). The stage's notes count the values it
  encoded.

Reads go through two views (R27):

| View | Shows |
|---|---|
| `current_forensic_records` | Completed units only, at each file's latest completed parser version. An unfinished re-parse never hides finished facts |
| `forensic_records_history` | Every completed unit at every version, opt-in |

The report and the desktop app both read these views, so they can't disagree.

## Time

Timestamps are UTC and timezone-aware, or null; a time is never guessed (R11).
A plausible but wrong date is worse than none, so ambiguous numeric timestamps
are rejected rather than interpreted (EPOCH-419). Records without a time are
counted and shown, never dropped.

## Tool defects

A tool's output is checked, not trusted (R36). Checks run on every ingest; for
iLEAPP, each artifact's declared times are compared with the device era
(2007-06-29, the first iPhone) and with the time of the run. A time outside it
is never altered: it is marked on its record in `fields.time_review` (the
column, the time and the check), and the report lists every marked column for
review.

A defect confirmed against the evidence the tool read is registered in
`packages/contracts/tool_defects/<tool>.json`. An entry names the tool and the
versions it affects (as the tool reports its own version), the module, the
artifacts and columns (a correction applies only where all of them match), the defect, the evidence, the correction, the ticket and
the upstream status. Entries are never deleted; a fixed release simply falls
outside an entry's versions.

The stage applies a correction only from the registry. The record keeps the
tool's value under the tool's own column header, takes the corrected value
where our model holds it (`event_time` for a time), and lists each correction
in `fields.corrections`: the defect, the column, the original and the corrected
value. Corrections are not part of the unit's identity, which stays the tool's
content: an entry names the stage parser version that first applies it
(`applied_from`), a test holds the stage at or above it, and that newer version
supersedes the uncorrected facts of the same unit (R8). The report lists every
correction it relies on, with the defect behind it.

## What is not modelled yet

| Gap | Ticket |
|---|---|
| Database-level immutability of completed facts, and one audited purge procedure | EPOCH-412 |
| LLM findings versioned by model and prompt (today they dedup across models) | EPOCH-426 |
| Facts from a superseded results set or iLEAPP output still read as current | EPOCH-428 |
