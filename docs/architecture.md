# Architecture

This page explains what each part of Verichron Epoch does and how evidence moves
through it. Identity and provenance are explained in
[evidence-model.md](evidence-model.md); the rules referenced as `R<n>` are in
[rules.md](rules.md).

## The pipeline

```mermaid
flowchart LR
  A[Encrypted backup] --> B[processor]
  B -->|evidence/ sidecar + manifest| W[(Workspace)]
  B -->|decrypted/ + results/ + ileapp/ with markers| W
  W --> C[orchestrator]
  C -->|register evidence| D[(PostgreSQL)]
  C -->|spawn in order| S[stages]
  S -->|facts via ingest()| D
  D --> R[report]
  D --> E[desktop app]
```

Evidence moves through five steps: **acquire → process → extract (ETL) →
analyze → report**. The orchestrator coordinates the last three.

1. **Acquire.** The desktop app pulls an encrypted backup from a connected
   device (or the examiner supplies one).
2. **Process (`processor`).** For each backup it:
   - hashes every file into a canonical manifest, which gives the evidence its
     identity (`content_root`);
   - decrypts it with `mvt-ios`, then repairs malformed SQLite databases;
   - runs `mvt-ios check-backup` against a hashed copy of the IOC set;
   - runs iLEAPP over the decrypt.

   Each output is a **derivative**: a separate product of the evidence, which
   itself is never altered. Each carries a marker recording what produced it.
3. **Extract (ETL, `apps/extractors/*`).** The orchestrator verifies the
   evidence and markers, registers the evidence, its device and derivatives, and
   decides whether a run is needed. It then runs the stages in `stage.json` order
   as subprocesses, passing each one its identity and the derivative it declares
   it reads. Each extraction stage reads that derivative, normalizes it, and
   loads facts through the one writer, `ingest()`, one atomic unit per source
   file.
4. **Analyze (`apps/analysis`).** The LLM stage proposes leads from the facts;
   leads are never evidence.
5. **Report (`apps/reporting`, the desktop app).** The report and the app read
   facts through database views, so both languages apply the same selection
   rules (R27).

## Acquiring from an iPhone

The desktop app pulls a full, encrypted backup with `idevicebackup2`
(EPOCH-466). Three rules protect the evidence (EPOCH-483):

- **A pull writes only into a new folder.** When the destination already holds
  anything for the device, whether a finished backup, an unfinished one, or a
  folder Epoch can't read, the pull is refused before the device is touched.
  The examiner chooses another folder, or deletes an unfinished backup.
- **An unfinished backup can't be resumed.** It is offered for deletion, never
  deleted automatically, and never written into.
- **Success is checked, not assumed.** A pull is reported complete only when the
  backup's `Status.plist` says `finished` and its `Manifest.db` exists.

### Verified device behaviour

What the app says about a pull must match an entry here. An entry is added only
from a real device's output, with the date, model, iOS version and tool version.

| Behaviour | Observed output | Device · iOS · tool | Date |
|---|---|---|---|
| A locked device refuses the backup | `ErrorCode 208: Device locked (MBErrorDomain/208)` | iPhone17,5 · 26.6.1 · idevicebackup2 1.4.0 | 2026-10-11 |
| The backup waits for the passcode to be entered on the device before it starts | `*** Waiting for passcode to be entered on the device ***` | iPhone17,5 · 26.6.1 · 1.4.0 | 2026-10-11, 2026-10-12 |
| The device judges the computer's free space itself and refuses when it decides there isn't enough | `ErrorCode 105: Insufficient free disk space on drive to back up (MBErrorDomain/105)`, with 90.3 GB free | iPhone17,5 · 26.6.1 · 1.4.0 | 2026-10-11 |
| An interrupted backup is not resumed. Run again without `--full` over the unfinished folder (`Status.plist`: `BackupState` empty, `SnapshotState` uploading), the tool chose incremental mode; the device read `Status.plist`, refused with ErrorCode 105 (19 GB free), and sent no files. The folder was unchanged (92,158,497,093 bytes before and after) | `Incremental backup mode.` … `Sending '<device>/Status.plist' (192 Bytes)` … `ErrorCode 105` … `Received 0 files from device.` | iPhone17,5 · 26.6.1 · 1.4.0 | 2026-10-12 |
| The tool's overall percentage doesn't follow the data received | Shown in the app as 35–50% when 86 of about 96 GB had arrived | iPhone17,5 · 26.6.1 · 1.4.0 | 2026-10-11 |
| A full pull into a new folder finished and passed the completion check, in 3 h 14 min, receiving 77,217,764,077 bytes against an estimate of about 96 GB | `Status.plist`: `SnapshotState` finished; `Manifest.db` present; `Manifest.plist`: `IsEncrypted` true | iPhone17,5 · 26.6.1 · 1.4.0 | 2026-10-12 |
| `IsFullBackup` in `Status.plist` is false after a full backup, so it isn't a measure of completeness. The tool was run with `--full` (it sends `ForceFullBackup`) into a folder that didn't exist; idevicebackup2 never writes the key, so the device sets it. Published Finder and iTunes backups also show false | `IsFullBackup` false, `BackupState` new, `Version` 3.3 | iPhone17,5 · 26.6.1 · 1.4.0 | 2026-10-12 |

## Components

Each concern has exactly one owner (R2).

| Component | Owns | Does not |
|---|---|---|
| `apps/epoch` | Device pull, starting runs, showing runs, records, IOCs and reports | Decide run state or write facts |
| `apps/processor` | Hashing evidence, decrypt, repair, IOC set, `mvt-ios` and iLEAPP invocation, completion markers | Touch the database |
| `apps/orchestrator` | Evidence registration, run creation, stage order, run and stage state | Parse evidence |
| Stages (`apps/extractors/*`, `apps/analysis`, `apps/reporting`) | Turning one derivative's files into facts, or rendering the report | Choose their own identity (R16) or commit transactions (R15) |
| `packages/etl-db-writer` | `ingest()`, the ledger, migrations | Parse anything (R15) |
| `packages/etl-db-reader` | Named, read-only questions for the app (R24) | Write |
| `packages/contracts` | Schemas, record types, marker formats, path helpers | Policy (R3) |

Languages split by role: TypeScript runs the control plane (app, processor,
orchestrator); Python parses, writes facts and renders the report. They meet
only at process boundaries (a stage is a subprocess) and in the database.

## The workspace

The processor creates one workspace per batch of backups. Each backup is a
*label* (its directory name).

```
<workspace>/
  evidence/<label>/sidecar.json            identity: content_root, file count, source path
  evidence/<label>/manifests/<root>.sha256 canonical manifest, content-addressed, never overwritten
  evidence/<label>/fingerprints.json       stat cache that makes re-hashing cheap
  decrypted/<label>/                       decrypted backup + .mvt_decrypted_ok marker
  results/<label>/                         mvt-ios output + .mvt_check_ok marker
  ileapp/<label>/                          iLEAPP's report + .ileapp_ok marker
  logs/<label>.log                         check-backup output
  logs/<label>.ileapp.log                  iLEAPP output
  summary.json, summary.md                 the processor's run summary
```

Today the orchestrator and app find these directories by layout. A workspace
manifest replaces that (R18, EPOCH-427).

## The database

| Group | Tables and views | Purpose |
|---|---|---|
| Evidence | `devices`, `evidence_items`, `evidence_locations`, `evidence_derivatives`, `evidence_events` | What the evidence is, where it was seen, what was derived from it, and an append-only custody log |
| Runs | `pipeline_runs`, `pipeline_stage_status`, view `run_completeness` | Audit of each pipeline invocation; completeness is derived in one place (R23) |
| Facts | `ingested_files`, `forensic_records`, views `current_forensic_records`, `forensic_records_history` | The ledger of processed source files and the facts they produced |

Migrations live in `packages/etl-db-writer/migrations` and are applied by
`migrate.py` (see [development.md](development.md)).

## Stages

A stage is a directory with a `stage.json` the orchestrator discovers at startup.
The contract is in
[EXTRACTOR_CONTRACT.md](../packages/contracts/EXTRACTOR_CONTRACT.md).

| Stage | Order | Reads | Writes |
|---|---|---|---|
| `crash` | 10 | decrypted backup | `crash_report` |
| `ileapp_bridge` | 20 | iLEAPP output | `ileapp_record` |
| `mvt_iocs` | 70 | mvt results | `mvt_ioc_detection`, `timestamp_anomaly` |
| `analysis` | 80 | mvt results, via a local LLM | `llm_flagged_anomaly` (leads) |
| `reporting` | 1000 | the database | the investigation report |

## Builds

The first release is a **Lab build**: air-gapped, with IOC sets and tools
imported from media and recorded (EPOCH-438, EPOCH-439). A Personal build comes
later from the same core. Lab and Personal are separate builds, not a runtime
switch ([decisions](decisions.md#product-and-builds)).

## Changes already decided

These are settled but not yet built; this page will change when they land.

| Change | Ticket |
|---|---|
| The app reads typed events from the processor and the orchestrator instead of scraping logs | EPOCH-443, EPOCH-445 |
| A workspace manifest replaces path inference | EPOCH-427 |
| Secrets travel by environment, never on the command line | EPOCH-423 |
| The TypeScript fact writer is removed; Python is the only writer | EPOCH-452 |
