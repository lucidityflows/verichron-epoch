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

**What names an investigation.** The same `Info.plist` gives each piece of
evidence its model (`Product Type`), iOS version (`Product Version`) and backup
date (`Last Backup Date`, when the backup began), recorded on `evidence_items`
at registration (migration 0019, EPOCH-555). A backup whose `Info.plist` lacks
any of them is refused. The app names an investigation by these, never by the
UDID or the backup's path ([DESIGN.md](../apps/epoch/DESIGN.md) §7).

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
  gets `<UDID>.crash-reports.json`: the tool, when it was copied, when the
  backup finished, and the file and byte counts. The pull record says what the
  copy did; a failed copy doesn't fail the completed backup, and removes the
  folder it created, so it can be copied again.
- **Copied again after a failed copy** (EPOCH-519), for example when the device
  locked: only from the device the backup came from, only for a finished
  backup with no copy yet, and recorded as its own line in the pull record.
  The device's reports change during the day, so the report states how long
  after the backup finished they were copied.
- **Copied by the processor.** It copies them into
  the crash-report path declared for that label in `workspace.json`, hashes
  the copy the way a backup is hashed, and writes `.crash_reports_ok` once the
  copy matches the pull's folder. A folder without the pull's record, or one
  that changed after the pull, is not used.
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
  - the decrypt and iLEAPP each run in their own Python environment, so their
    `tool` also records that environment's `environment` digest: sha256 of its
    Python version and every installed distribution with its version, as its
    own interpreter lists them (EPOCH-439);
- `provenance_key` is the sha256 of that provenance in canonical form, with
  each preserved original counted as the database it came from: when a copy
  was set aside shaped nothing, so a repeated decrypt with the same repair
  outcome is the same derivative (EPOCH-517);
- a different tool version, tool environment, repair outcome or iLEAPP commit
  is therefore a **new derivative**. iLEAPP output from another commit or
  environment is made again; a finished decrypt is kept when only its tool
  changed, and records the tool and environment that made it. A derivative's identity is never rewritten.
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

**Indicator sets** (EPOCH-490) are data the project's own matching reads
(EPOCH-491), not derivatives of any evidence. A set is a list of STIX 2.1
files. Its identity, the **set hash**, is the SHA-256 of its canonical
manifest: for each file, its path in the set, the SHA-256 of its bytes, and its
provenance (source repository, source commit, licence and download date), with
the index commit it was fetched from. The same files with the same provenance
are the same set in any order; one changed byte is another set.

`apps/indicator_registry/register.py` loads a set and registers it whole, in
one transaction: each file's bytes (stored by SHA-256), the set, each file's
provenance and counts, and one row per indicator value. Registering the same
set again changes nothing. The registry is append-only, in the writer and in
the database, so a newer set sits beside the older one and an earlier result
can still name the set it used.

Every indicator in a file is loaded, revoked, or unsupported for a named
reason (an operator other than `=` and `IN`, a qualifier, a type no backup
supplies, and so on), and the three counts are stored with the file. An
indicator past its `valid_until` is loaded and flagged as expired. A file that
isn't a valid STIX 2.1 bundle rejects the whole set. Each value is normalized
by the one function the matcher also applies to facts
(`indicator_normalize.normalize`), so the two can't drift.

Which indicator types a check compares, and with which kind of entity, is
declared in [indicator types](indicator-types.md) (EPOCH-581, replacing the
field map of EPOCH-521).

**Indicator matching** (EPOCH-491) is the `indicator_match` stage. Its input is
not a derivative but a registered set, which its stage row records
(`pipeline_stage_status.indicator_set_id`), so a run states which set it
checked and a newer set gets a new run. It compares the indicators with the
evidence's current [entities](#entities) (EPOCH-581), which are normalized as
the indicators are, and matches on equality: a domain exactly or as a
subdomain on a label boundary, with the mode recorded; each URL's host is a
domain entity too. No match is fuzzy, and nothing heuristic is recorded as a
match.

A check is one unit, filed under the set: a unit reads exactly one input, a
derivative or a set (`ingested_files.derivative_id` or `indicator_set_id`).
Its identity hash covers the set, `indicator_types.json` and every entity unit
read, so the same set over the same entities is already done (R22), and newer
facts, newer rules or another set give a new unit beside the old one (R8). Each match is an
`indicator_match` fact (tier: tool judgement, R10) holding the indicator, the
match mode, and the record and entity it matched (the entity's kind, the field
it was read from and its normalized value), which leads back to that record's
derivative and evidence; its time is the record's, exactly as stored (R11).
The unit's summary says, per indicator type, how many values were compared
from which sources and what each rule couldn't read, and what wasn't checked
and why: no entity kind covers the type, or no record in this case mentions
one. It also states the fields that held values and that no entity rule
reads, and any record the entities stage hasn't read, which is a warning. A check that finds nothing is still a completed unit with
that summary, so "no match" is never recorded without what wasn't checked.
The report and the app read checks through the `indicator_checks` and
`indicator_set_sources` views (R27).

## Runs

A *run* is one invocation of the pipeline over one piece of evidence. **A run is
an audit event; facts belong to evidence, not to runs (R7).**

- Every rerun creates a new run; finished runs are never reopened.
- Each stage's row records its status, times, the parser version it ran at and
  the derivative it read. A failed stage's stderr is its `error_message`; a
  succeeded stage's stderr is its `warnings` (EPOCH-420), which never change
  the run's state.
- **Each item a stage could not ingest is kept** (EPOCH-432) in
  `stage_item_failures`: the run and stage (labels, like run links, with no
  foreign key), the evidence and derivative, the item's path relative to that
  derivative and where it was (`file_path`, built as the ledger builds a
  unit's), its sha256 when it could be read, and the reason. The table is
  append-only. The `still_failing_items` view (R27) gives each item's latest
  failure unless a unit of the same evidence and source type completed after
  it, with the item's hash or, without one, its `file_path`. Failing items are visible, not hidden: a rerun retries
  them, since a failed file leaves no ledger row.
- **How a run ends is recorded** (EPOCH-435, migration 0017).
  - **What a run records:**
    - `host` and `pid`: the orchestrator process that created the run.
    - Once it ends, `ended_reason`: `completed`, `cancelled`, `timeout`, `crashed` or `abandoned`. It is set exactly when `finished_at` is.
    - `ended_detail`: what was known about why.
    - `display_zone` (EPOCH-560, migration 0020): the zone its report shows times in, UTC or the named zone chosen in Settings. The report reads it from the run. Stored times stay UTC (R11).
    - `kind` (EPOCH-557, migration 0023): `analysis`, or `indicator_check` for Check Again, a run of the indicator check alone. Only analyses count as "already done" for Analyze, and the app shows an analysis, not a check, as the investigation's.
  - **Who closes a run the orchestrator didn't finish:**
    - The orchestrator closes its own run as `crashed`, with its error.
    - The app closes a call's runs by ID, from their `run:created` events: as `cancelled` on a cancel, `timeout` when stalled, or `crashed` when the process died.
    - The app's sweep, at start and before reporting a workspace's status, closes as `abandoned` every open run on this host whose process is gone. It leaves runs on other hosts alone.
  - **Stage rows are never rewritten.** A stage that never finished keeps its status. On an ended run it reads as stopped, and the run is incomplete.
  - **Interrupted stages:** the `interrupted_stages` view (R27) gives each evidence's fact-writing stages whose latest attempt ended this way. Such a stage recorded none of the items it failed (EPOCH-561).
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
- **Run attribution is append-only (R7).** `ingest_run_links` associates each
  completed unit with every run that successfully read or deduplicated it.
  These links are separate from `ingested_files`, so recording a later run never
  updates a completed ledger row; deleting a run does not delete its links.
- **Completed units are immutable in PostgreSQL (R9), against the runtime too** (EPOCH-562). The tables belong to a non-login schema owner, and the app connects as a role that can neither TRUNCATE them nor alter their triggers. Database triggers
  reject changes to completed ledger rows and their facts. Reclaiming an
  incomplete unit may still delete its orphaned records. The
  `purge_evidence(evidence_id, reason)` function, owned by a dedicated
  non-login database role, is the only completed-data deletion route: it
  removes the evidence's facts, run links, ledger rows and failed items (whose
  reasons can quote evidence), then appends an immutable `evidence_events`
  record with the database actor, timestamp, reason and deletion counts. Evidence registration and custody events remain.
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

- **Every source type is registered with its tier (R10).** `source_type_tiers`
  (migration 0021) names each one Observed, Tool judgement or Lead, and
  `forensic_records` refers to it, so a record of an unregistered type can't be
  written. A Lead (an AI-assisted lead) is never read among the facts.
- **Where an iLEAPP record came from is also a column.** `source_artifact`,
  `module` and `category` are generated from `fields` when a record is written
  (0021), so they are indexed and counted like `source_type`. Their one source
  stays `fields`. Each iLEAPP unit's payload names its artifact's columns with
  the type iLEAPP declared (`columns`: column, header, type; parser version 6),
  so a reader shows a time as a time without guessing.
- **Search reads values, never names.** `record_values_text(fields)` joins a
  record's values, indexed by trigram (`pg_trgm`).

Reads go through two views (R27):

| View | Shows |
|---|---|
| `current_forensic_records` | Completed units only, at each file's latest completed parser version. An unfinished re-parse never hides finished facts |
| `forensic_records_history` | Every completed unit at every version, opt-in |

The report and the desktop app both read these views, so they can't disagree.

**Correlated context** (EPOCH-522, migration 0024) is read the same way: the
evidence's other records within a window of time around one record, through
SQL functions both the report and the app call. Neither declares a window, and
a test greps the code for one.

| Function | Gives |
|---|---|
| `correlation_window()` | The default half-width, ±15 minutes: defined here and nowhere else |
| `record_context_window(evidence, record)` | The window: whole seconds from the second `time − window` falls in through the second `time + window` falls in, as `[window_from, window_before)`. Nulls for a record with no time (R11); no row for a record that isn't current in this evidence |
| `record_context(evidence, record, window, limit)` | The records in it, nearest first, leaving out the record and its own indicator matches |
| `record_context_counts(evidence, record, window)` | The window's true counts by source and artifact (R25) |

The bounds are scalar subqueries, so the range is the time index's own
condition (`idx_forensic_evidence_time`); on a real 44,000-record backup the
busiest window (792 records) reads in about 25 ms.

## Entities

What a record mentions is read out of it once, by declared rules, and stored
(EPOCH-581): domains, URLs, apps (bundle IDs), processes, email addresses,
phone numbers, IP addresses, Wi-Fi networks and access points, and Bluetooth
devices. One value of one kind is an **entity**; it always names its record.

- **A rule names a field, never a shape.** Each rule in
  `packages/contracts/entity_rules.json` names one field of one source (an
  iLEAPP artifact's header, or a crash report's column) and the kind it holds.
  On a real backup, 129 columns had a phone number's shape and most held
  coordinates, byte counts and scores, so a shape only checks a rule: a value
  that doesn't fit its kind is counted, never stored. The one general rule is
  iLEAPP's own: a column it declares `phonenumber` holds phone numbers. Free
  text (SMS, Notes, page titles) is read for URLs with a scheme, email
  addresses and IPv4 addresses only, shapes nothing else has; numbers in text
  are not read as phone numbers. General limitations are in the file's
  `not_covered`; reviewed iLEAPP artifact/header pairs deliberately left
  unruled are in `excluded_headers`, each with its reason. An exclusion does
  not hide a populated field: it remains in the unit's unread-field summary.
  The VER-291, VER-288 and browser/history checkpoint of VER-284
  `reviewed_artifacts` are checked against the pinned source inventory, so
  every header in their reviewed Apple-native app, Biome, and browser scopes
  has exactly one rule or a reasoned exclusion.
- **The field is the role.** An entity keeps the field it was read from
  ("Imported by Bundle ID"), so "the app that imported this photo" and "the app
  whose state this is" stay apart without a second taxonomy.
- **One normalization for facts and indicators (R2).** URLs, domains, apps,
  processes, email and IP addresses are normalized by `indicator_normalize`, as
  indicators are; phone numbers (digits, a leading + kept, nothing added), MAC
  addresses and SSIDs by `entity_normalize`.
- **A stage that reads facts.** The `entities` stage reads the evidence's
  current crash-report and iLEAPP units (`"reads": "facts"`), and writes one
  unit of its own per fact unit, which names it (`source_ingest_id`, migration
  0022). Its parser version is the rules' version; a changed rule set is a new
  unit beside the old (R8). An entity unit holds no records (its
  `record_count` is 0); its entities are in `record_entities`, which, like
  records, can't change once their unit completed (R9), and can only name a
  record of the unit their unit was read from. Only the normalized value is
  kept; the value as stored is the record's own.
- **What isn't read is stated.** Each unit's payload counts, per rule, the
  values read, those that didn't fit and those of another kind, and lists every
  field that held values and that no rule reads. The app and the report state
  both, so a gap in the rules is never read as "not mentioned".
- **Shape hints rank what isn't read.** For each field no rule reads, the
  stage counts the values shaped like a URL, an email, IPv4 or MAC address, a
  phone number (with its +) or a bundle ID (`entity_normalize.SHAPE_HINTS`,
  titled in the rules file's `shape_hints`). The app and the report list those
  fields first. A hint never decides a value's kind and nothing is stored from
  it; it is permanent, so a field from a new iOS, iLEAPP or app is flagged on
  every analysis until it is classified. On the reference backup it ranked 31
  of 2,251 unread fields (2026-10-20).

| View | Shows |
|---|---|
| `current_record_entities` | The entities of current entity units whose record is current |
| `current_entity_units` | Each current entity unit of a current fact unit, with its payload |
| `entity_rule_reads` | What each rule read, per source |
| `entity_unread_fields` | Each field that held values and that no rule reads, per source |

`scripts/check_entity_rules.py` runs every rule against a real iLEAPP output,
counts only. For the EPOCH-582 review batches, counts-only checks and authorized
real-output schema snapshots are finalized together in VER-287 after the
implementation reviews. Those implementation PRs do not require a prepared
output path; EPOCH-582 remains open until verification and any evidence
limitations are recorded.

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
