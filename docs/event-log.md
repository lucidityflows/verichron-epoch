# Event Log

How each task's log is written, sanitized, saved and read (EPOCH-570,
EPOCH-445). Designed and approved by the project owner on 2026-10-18; the
decisions are recorded in [decisions.md](decisions.md).

## 1. What the log is for

One saved record of what each task did, read in several places:

| Consumer | Reads | Built in |
|---|---|---|
| Docked bar | the latest non-debug entry, warning and error counts | U2 |
| Activity Log drawer, New Investigation | the current task's entries, live, then from the file after a restart | U2 |
| Failure banner and Copy Details | the failed backup's step and reason, and the entries around it | U2 |
| Backup row ("Partly prepared · prepare again") | the reason, from `summary.json` | U2 |
| Copy, Save As…, Pop Out | sanitized entries only | U2 |
| Activity Log drawer, Investigations | the selected investigation's Analyze log, found by run id | U4 |
| Diagnosis (EPOCH-569) | the full log, including debug output and how the process ended | U2 |

**What it is not:**
- It is not evidence, and it is not a store of facts: those are in the database (R7).
- It is not where progress state comes from. Progress is derived from the same typed events while the task runs.

**Quality bar:** whatever a consumer needs must be saved at the source, typed and sanitized. Nothing downstream may re-derive levels, steps or reasons from text.

## 2. Principles

1. **Typed at the source.**
   - The program that knows decides each entry's level, step and reason.
   - The app never assigns a level by matching text (EPOCH-570 scope 1).
2. **One writer per log file:** the app's main process. It is the only component that sees the whole task: the spawn, every stream, the password exchange, a cancel or timeout, and the exit code or signal.
3. **Sanitized once, before the entry exists anywhere** (§6).
   - The writer sanitizes each entry before it goes into memory, over IPC or to disk.
   - Display, Copy, Save As and Pop Out read only sanitized entries.
   - The unsanitized form is never stored.
4. **Append-only and self-describing.** Each file opens with a header and closes with a result. A missing result means the task never finished.
5. **Fail fast and visibly.**
   - An event that doesn't validate becomes an ERROR entry. It is never dropped.
   - A log that can't be created stops the task before any work starts (§7).
6. **Store only what a consumer needs, and say why** (owner, 2026-10-18).
   - Every field and every kind of detail the log keeps is listed in §6.6, with the consumer that needs it.
   - Anything without a reason is not written, and what is not written can't be shown, copied or leaked.
   - The examiner's workstation is not the subject of the log. Its paths become named roots (§6.3), and its account name, host and command lines are not recorded.

## 3. Tasks and files

- **Task kinds:**
  - `prepare` (the processor) and `analyze` (the orchestrator) are wired in U2.
  - `pull` (iPhone backup) has the same contract and adopts it in U3.
- **Task id:** a UUID the app creates when the task starts.
- **File:** `<kind>-<start, compact UTC>-<task id, first 8>.ndjson`, for example `prepare-2026-10-18T153002Z-1f3a9c2e.ndjson`, in the folder the workspace's manifest declares as `task_logs_path` (`logs` in a new workspace). Like every workspace path, it is never built from a name in code (the manifest contract).
  - The folder is `0700`: it also holds iLEAPP's logs, and both are case material (owner, 2026-10-18). The writer sets the mode each time it opens a log, because `mkdir` sets it only on a folder it creates.
  - A workspace used for the first time gets its `workspace.json` from the app, with the standard layout and only if there is none, before the first log is opened.
  - The compact UTC form matches the folder labels ([DESIGN.md](../apps/epoch/DESIGN.md) §11).
- **Permissions:** `0600`, like `summary.json`. The log is case material (§6.1).
- **Retention:** the log is kept with the workspace, and the app never deletes it.

## 4. Entry schema (version 1)

One JSON object per line, validated with zod in `packages/contracts` (`TaskLogEntry`):

| Field | Type | Meaning |
|---|---|---|
| `v` | `1` | schema version |
| `task_id` | uuid | the task |
| `seq` | int ≥ 1 | strictly increasing within the task; set by the writer |
| `at` | ISO 8601, ms, `Z` | when it happened (see `clock`) |
| `clock` | `source` \| `received` | `source`: the producer's own time from its event; `received`: when the writer received a raw line, or the app's own entry |
| `level` | `error` \| `warn` \| `info` \| `debug` | §5 |
| `source` | `app` \| `processor` \| `orchestrator` \| `stage:<name>` \| `tool:<name>` | who said it; tools are `ileapp`, `decrypt`, `sqlite3`, `idevicebackup2` |
| `kind` | `task:started` \| `task:finished` \| `event` \| `message` \| `output` | what the entry is: the header, the result, a producer's event, the app's own line, or a line of output that is not an event |
| `label` | string \| null | the backup's dated label, when the entry concerns one |
| `step` | string \| null | the processor step (`hash`, `decrypt`, `repair`, `ileapp`, `crash`) or the stage name |
| `message` | string | one sanitized sentence, shown as is |
| `event` | `PipelineEvent` | `kind: event` only: the typed event, every text field sanitized |
| `task` | object | `kind: task:started` only (below) |
| `result` | object | `kind: task:finished` only (below) |
| `stream` | `stdout` \| `stderr` | `kind: output` only |

**`task:started`** is always `seq` 1. Its `task` records:
- the kind and the app version. The workspace's location is not recorded, because the log is inside it (§6.6);
- the selected labels, and the options that change what the task does (for example `force_decrypt`), as fields.

Times are always UTC: `at` ends in `Z`.

**`task:finished`** is always the last entry. Its `result` records:
- the outcome: `succeeded` | `failed` | `cancelled` | `timed-out` | `crashed`;
- the exit code or signal, and whether the producer reported its own result before it ended;
- the labels that failed, and why entries could not be saved, if any (§7).

The schema also enforces three rules:
- an `event` entry's level is the event's level (§5);
- an `output` entry is `debug`;
- `task:started` is the first entry.

If a file has no `task:finished`, the app was closed or killed mid-task. The reader shows this as **Interrupted · the app was closed**, as the U1 status chip does.

## 5. Levels

Each level has a fixed meaning. A typed event gets its level from `eventLevel()` in the contract, by its type and status, never from its text.

**One failure is one `error`,** where it happened, for example the `backup:step` that failed. The summaries after it, such as the failed backup's `backup:finished` or an incomplete run's `run:finished`, are `info`. That way the error count is the number of failures.

| Level | Means | Examples |
|---|---|---|
| `error` | a step or the task failed; the result is missing something it should have | `[decrypt]` failed for a backup; the processor ended by a signal without reporting; an event didn't validate |
| `warn` | finished, but needs a second look; counted and listed | an iLEAPP plugin errored; a password was wrong and is asked for again |
| `info` | a milestone an examiner wants in the bar | task started or finished; a backup started; a step done or skipped as already done; the password requested |
| `debug` | detail | progress ticks, tool versions, all raw tool and stage output |

**For review** is how the log shows a `warn` that is not a problem with the run but something in the evidence worth an examiner's look: an impossible or future time, a value stored encoded or corrected for a tool defect, an indicator match (owner, 2026-10-18). A stage marks it when it reports it (`review`). A problem with the run is shown as a Warning. A database repair could not recover is more than that: the backup's data may be incomplete, so it is the repair step's `error` and the backup needs attention (owner, 2026-10-18).

**Raw output is `debug` because of where it comes from.** iLEAPP, the decrypt tool, sqlite3 and stage scripts write free text that we don't control.
- Their failures reach the log as the processor's or orchestrator's own `error`, with the step and the reason.
- The raw text stays available under Debug Detail. This is a fixed rule by source, not a guess.

## 6. Sanitization

### 6.1 Threat model

**Who reads a shared log:** whoever the examiner gives it to through Copy, Save As, Copy Details or a screen on a second monitor. That could be a colleague, a ticket or an email.

**What must not reach them:**

| Class | Why | How |
|---|---|---|
| Secrets (backup passwords, database credentials) | direct harm | **prevented at the source** (§6.2) |
| Device identifiers (UDID, serial number, IMEI, MEID, ICCID, phone number, backup GUID) | identify a person's device | **known-value replacement** (§6.3) |
| The examiner's workstation: absolute paths outside the workspace (the source folder the backups came from, the app's install folder, the temporary folder), the home folder, the account name, the host name, process ids, command lines | describe the examiner's machine; no consumer needs them | named roots (§6.3), or not recorded at all where §6.6 gives no reason |

**Out of scope:**
- Evidence-derived content in debug output: app bundle identifiers, artifact file paths, iLEAPP's notes.
- The log is case material, stored with the evidence. It is not a public artifact.
- The bar, Copy Details and the default drawer view hide debug entries. Save As writes the whole log, debug included, because diagnosis needs it.

**Evidence records are never sanitized:** `sidecar.json`, `workspace.json`, the pull records and the database keep the real source paths and identifiers, for chain of custody. Sanitization applies only to the task log, and to the processor's human summaries (`summary.md`, and the `reason` text in `summary.json`).

### 6.2 Secrets are prevented, not redacted

- The backup password goes only over stdin. It is never in arguments, the environment or an event (R30, EPOCH-423).
- The `password:required` event carries the label and the attempt count, never a value.
- The database URL's password is already redacted in error messages (decisions.md, EPOCH-423/424).
- **Tripwire:**
  - While a task runs, the writer holds the passwords the examiner entered for it.
  - Any entry containing one has it replaced with `[password]`, anywhere in the text, even inside a longer token, and an `error` entry says that a secret reached the output. A short password can match innocent text and raise a false alarm; that is accepted, since missing one costs more (owner, 2026-10-18).
  - This is never expected. It is a test of the prevention, not the mechanism.
  - The passwords are discarded when the task ends.

### 6.3 Known-value replacement: no pattern guessing

**Why no patterns:**
- Pattern-based secret detection already cost this project time with false positives (the GitGuardian incidents on the CI test credentials).
- On a real Prepare log (5,650 lines, measured 2026-10-18), naive replacement of the Info.plist **Device Name** matched inside a tool's name and inside an installed app's bundle identifier. Neither occurrence was the device's name.

So the sanitizer replaces only **exact values that the workspace and the workstation themselves report**, and only for classes that are high-entropy or are paths.

**Where the values come from** (collected by the app before the task starts, then held by the writer):
- each selected backup's folder name, which is its UDID (measured: the folder name equals Info.plist `Unique Identifier`);
- from each backup's `Info.plist`: `Unique Identifier`, `Target Identifier`, `GUID`, `Serial Number`, `IMEI`, `IMEI 2`, `MEID`, `ICCID`, `Phone Number`;
- for a pull (U3), the connected device's UDID;
- the workstation's roots: the workspace, the evidence source folder the examiner chose, the app's install folder, the temporary folder (`os.tmpdir()`), the home folder (`os.homedir()`), and the account name (`os.userInfo().username`).

**Class policy:**

| Class | Accepted value (validated before use) | Marker |
|---|---|---|
| UDID, Target Identifier | 25 characters `XXXXXXXX-XXXXXXXXXXXXXXXX` hex, or 40 hex | `[device <label>]` |
| GUID | 32 hex | `[device-guid <label>]` |
| Serial Number | 8–14 uppercase letters and digits | `[serial <label>]` |
| IMEI, IMEI 2 | 15 digits | `[imei <label>]` |
| MEID | 14 hex | `[meid <label>]` |
| ICCID | 19–20 digits | `[iccid <label>]` |
| Phone Number | as stored (measured: stored formatted, 17 characters holding 11 digits), and its derived forms: the digits alone, `+` and the digits, and the last 10 digits when there are more than 10 | `[phone <label>]` |
| Workspace | the absolute workspace path | `<workspace>` |
| Evidence source folder | the absolute folder the backups were chosen from | `<source>` |
| App install folder | the absolute app root (in development, the repository) | `<app>` |
| Temporary folder | `os.tmpdir()` | `<temp>` |
| Home folder | `os.homedir()` | `~` |
| Account name, inside a path | `os.userInfo().username` | `<user>` |
| **Not replaced:** Device Name, Display Name | free text, often a common word (measured false positive) | none |
| **Not replaced:** Product Type, iOS version, Build Version | not identifying; the board names devices by model and iOS | none |

The identifier formats were checked on 2026-10-18 against the Info.plist of the owner's two real backups, and every class matched. None of the values were printed.

**Accepted value** means the value read from Info.plist must itself match the format before it is used. A value that doesn't is not used, and a `warn` entry names its class and label but never the value.

**Matching:**
- Case-insensitive for identifiers; exact case for paths.
- **Whole token:** the match may not have a letter or digit directly before or after it. A UDID in `<source>/<label>/<UDID>/Manifest.db` matches; the same characters inside a longer hex string do not.
- For a phone number's digit forms, the neighbours may not be digits.
- **Roots** match only as a path prefix: followed by `/` or the end of the text. They are tried most specific first (workspace, source, app, temporary, then home), so `/home/<name>/verichron-workspace/ileapp/x` becomes `<workspace>/ileapp/x`, not `~/verichron-workspace/ileapp/x`.
- **The account name** is replaced only inside a path, as a whole token. One example is the `-home-<name>-` segment inside a temporary folder's name, which was measured in a real log. It is not replaced in free text, because an account name can be a common word (the Device Name lesson).

**Markers:**
- A marker names the evidence by its dated label, as the board asks.
- The name a marker uses is an input to the sanitizer, which refuses a name containing one of the device's identifiers. A backup stored directly in a folder named by its UDID (the Finder layout) would otherwise have its UDID as its label. Such a backup is named by device model · iOS version · backup date from its Info.plist, with a counter when two would read the same (owner, 2026-10-18; `deviceIdentifierSources` in `packages/contracts`).
- It says what was removed and stays unambiguous within the workspace. The examiner can map it back through the workspace's own records.

**If identifiers can't be read:** when a backup's Info.plist can't be read, its folder name (the UDID) is still replaced. A `warn` entry says that the other identifiers for that label could not be read.

### 6.4 Where sanitization runs

- **In one place**, the `Sanitizer` in `packages/contracts` (`ts/sanitize.ts`), built once per task from the identifiers and roots. It is used by:
  - the app's log writer, for every `message`, every text field of `event`, and `data`;
  - the processor, for `summary.md` and the `reason` field in `summary.json`.
- **Nowhere else.** Copy, Save As and Pop Out read sanitized entries, so they need no sanitizer of their own.

### 6.5 Verification gate (before the PR merges)

1. **Unit tests** with values in the real formats, using synthetic values: real identifiers never go in this public repository. They cover:
   - each class and its whole-token boundary;
   - a UDID in a source path, each root and its most-specific-first order, the account name inside a temporary folder's name, and the phone digit forms;
   - "no Device Name replacement" (a tool name that contains the device name stays intact), and no account-name replacement in free text;
   - the password tripwire, and that `password:required` carries no value.
2. **Real-data check, run locally, never in CI and never committed:**
   `pnpm --filter @verichron/epoch check:log-sanitizer <workspace> --out <review file>`
   (`apps/epoch/src/main/ipc/sanitizerCheck.ts`). It reads every saved log in the workspace and builds the sanitizer's known values from the workspace's own backups and the workstation's roots.
   - **On screen, counts only:** the logs and entries read, unreadable lines, the markers by kind, what is left of a known value (`residue`: any occurrence counts, inside a longer token too, and the account name anywhere inside a path), and how many distinct absolute paths remain.
   - **In the review file** (mode `0600`), because it quotes the logs: every line with a marker, and every remaining absolute path grouped by its first segments. The file is the owner's to read; it is never shown in a session or committed.
   - It passes only when there are logs, every line reads, and nothing is left of a known value.
3. **Acceptance:**
   - zero remaining identifier values, and no remaining path containing the home folder or the account name;
   - every changed line reviewed as a true replacement;
   - every remaining absolute path listed with its justification (for example `/usr/bin/sqlite3`, the tool that ran), or removed at its source.

   The measured command-line logs (2026-10-18) show what to expect. The paths outside the evidence were the repository (14 lines), the workspace (10), the source folder (2) and a temporary folder whose name embeds the account name (2). The UDID appeared in 1 line. The host name appeared only as part of the home path. Most of those lines go away at the source (§6.6); the rest become named roots.

### 6.6 What the log stores, and why

| Detail | Stored? | Why (consumer) | Form |
|---|---|---|---|
| Task kind, id, start and end, outcome, exit code or signal | yes | the drawer, the bar, Interrupted; diagnosis of how a process ended (EPOCH-569) | as is |
| App version; each tool's name and version | yes | which tool produced a result; reproducibility | as is (a version, never the tool's path) |
| Backup labels; device model and iOS version | yes | names the evidence, as the board asks | as is |
| Steps, levels, reasons, counts | yes | the banner, the backup row, the filters | sanitized |
| Paths inside the workspace | yes | which file a step wrote or failed on | `<workspace>/…` |
| Paths inside the evidence (for example `Library/SMS/…`) | debug only | diagnosis of an iLEAPP module | as the tool wrote them |
| Hashes (the evidence root hash) | yes | integrity: the same evidence was read | as is |
| The workspace's absolute location | **no** | the log is inside it | not recorded |
| The source folder's absolute location | **no** | the backup's label identifies it; the real path is in `workspace.json`, an evidence record | `<source>` if a tool prints it |
| The app's install folder, the tools' folders | **no** | the tool's version identifies it | `<app>` if a tool prints it |
| Temporary paths (summary files and similar) | **no** | the app chose them and needs no record | `<temp>` if a tool prints it |
| Command lines and arguments | **no** | the header records the selected labels and options as fields | not recorded |
| Host name, process ids, account name, environment variables | **no** | no consumer | not recorded; the account name inside a path becomes `<user>` |
| Development tooling output (pnpm's script banners) | **no** | not part of the task | not produced: the app runs pnpm with `--silent` (checked 2026-10-18: no banner, nested builds included), and the packaged app runs no pnpm |
| Passwords, database credentials | **never** | none | prevented at the source (§6.2) |
| Device identifiers | **never as values** | none | markers (§6.3) |

A field or detail is added to the log only together with a row here.

**Display follows storage.** The drawer, the bar, Copy, Save As and Pop Out show only what is stored, so this table is also the limit of what any view can reveal. The bar, Copy Details and the default drawer view show less: they leave out debug.

## 7. Writing and reading

**Writing:**
- At task start, the app collects the identifiers and roots, creates `logs/` and the file, and writes `task:started`.
  - If the file can't be created, the task **does not start**, and the reason is shown.
- Each entry is written as one line in a single append, through a serial queue, so lines never interleave.
  - The file is synced after each `error` entry and after `task:finished`, so a failure's cause survives a crash or a kill.
- If a write fails mid-task:
  - the task keeps running;
  - the bar shows "The log could not be saved: <reason>" as an error;
  - the entries stay in memory;
  - `task:finished` records the write failure, if it can still be written.
- The in-memory buffer stays capped (2,000 entries, as today) for the live view. The file is not capped.

**Reading:**
- Each line is validated against `TaskLogEntry`.
- A truncated **last** line, from a crash mid-write, is reported as "the log ends abruptly".
- Any other invalid line is shown as an `error` entry naming its line number. It is never skipped silently.
- The drawer virtualizes the list. The measured Prepare log has 5,650 raw lines, and a multi-backup Prepare may have tens of thousands.
- **Finding an Analyze log for an investigation (U4):** the reader scans the `task:started` headers and the `run:created` events. No index file is kept, because a second file could disagree with the logs.

## 8. Producers

### 8.1 Contract

The events below extend the existing `PipelineEvent` union (EPOCH-443): one contract, one prefix and one parser.
- **`log {level, message, label?, step?}`:** every line the processor or orchestrator writes for itself.
- **`stage:log {stage, level, message, review?, index?, total?}`:** what a stage reported it did (EPOCH-570), at the level it chose.
  - A stage reports with `stage_report.report()` (contracts' Python package): one line on stdout after `@@verichron-stage `. The orchestrator reads it and names the stage itself, so no stage can report as another. A line that doesn't read as a report stays the stage's output, and a warning says so.
  - The shared stage runner (`etl_run`) reports a stage's result ("44,619 record(s) written", or its own sentence, such as "no match against mvt-indicators") and each of its notes by kind. A note is `info` (what the stage did or covered), `review` or `warning`. Only `review` and `warning` notes go to stderr, which is stored as a succeeded stage's warnings (EPOCH-420), so a clean stage no longer reads as one with warnings.
  - `index` and `total` give a line's place, such as the 3rd of 9 indicator types.
  - Analysis stages have plain names (`STAGE_NAMES`): Reading crash logs, Reading device activity, Checking indicators, Writing the report.
- **`stage:output {stage, stream, line}`:** a stage's line, relayed by the orchestrator.
  - Both its stdout and its stderr are relayed. This replaces the earlier `[stage x]` tagging: the line is a field inside the event, so a stage can't pass for an event.
- **`stage:finished`** gains `reason`: required when the stage failed, and given when it was skipped. A failure's reason is the last line the stage wrote to stderr (a Python error's last line names it), or its stop reason. The whole text is in its relayed output and in `pipeline_stage_status.error_message`.
- **The processor's events (EPOCH-445):**
  - `prepare:backups {labels}`
  - `backup:step {label, step: hash|decrypt|repair|ileapp|crash, status: started|done|skipped|error, reason?, detail?}`. A failed step must give its reason; a finished one may say what it found (`detail`, e.g. its file count and root hash).
  - `hash:progress {label, bytes, files}`, `decrypt:progress {label, bytes, total}` and `ileapp:module {label, index, total, module}`, all at debug.
  - `password:required {label, attempt, max}`. It has no field for a password, and the contract refuses one.
  - `tool:output {tool: decrypt|ileapp|sqlite3, stream, line, label?}`: a line from a tool the processor runs.
  - `backup:finished {label, success, failed_step?, reason?}`. A failed backup must give its step and reason; a prepared one gives neither.
  - `prepare:finished {failed_labels}`. It carries no summary path: the app chose that path and passes it with `--summary-path`.
  - The orchestrator's `run:finished` keeps its name; the processor's is `prepare:finished`.
- **Each event type names the program that may emit it** (`EVENT_PRODUCERS`). The reader is told whose output it reads, and an event from the other program is invalid. A processor event in the orchestrator's output is never trusted.

### 8.2 Processor

- **One logger.** Every `console.log` and `console.error` goes through it.
  - With `--output events` (how the app runs it), stdout carries events only.
  - With `--output text`, the default for the command line, it writes the same events as human lines. Both use `eventMessage()` in the contract, so the command line and the app read the same words, and the text is free to change.
- Tool output is wrapped as `tool:output` with the tool's name.
- Tool lines report a tool's version, never its path.
- `summary.json` gains `failed_step` and `reason` per backup, sanitized, and is validated against `ProcessorSummary` in the contract before it is written. `summary.md` says the same in words.
- `prepareProgress.ts`'s regular expressions and `PASSWORD_PROMPT_RE` are deleted. The app consumes events.

### 8.3 Orchestrator

- Its own lines become `log` events, and stage output becomes `stage:output`.
- It no longer prints its argument list or its interpreter's path. The app's header records the labels and options as fields.
- A failed stage's `stage:finished` is its one `error`, with its reason (§8.1).
- Registration reads Info.plist with the contract's reader (`readPlistValues`), the same one the sanitizer uses.

### 8.4 App

- `TaskLog` (`apps/epoch/src/main/ipc/taskLog.ts`) is the writer. It collects identifiers and roots, sanitizes, assigns `seq`, hands each entry to the session and the renderer, and saves it.
  - The producer's event is handed back beside its entry, for the session to follow: progress, a password request, the running stage, the runs created. It is used in memory only; only the sanitized entry is kept.
- The app's own entries are:
  - the spawn;
  - **how the process ended**, in `task:finished`: the exit code or signal, and whether the producer reported its own result. EPOCH-569 lacked exactly this;
  - an event that didn't validate, or came from the other program;
  - the tripwire, and any identifier the sanitizer could not use.
- Prepare's progress comes from the processor's events (`applyPrepareEvent`), and the password dialog from `password:required`. The text parsing they replaced (`applyPrepareLogLine`, `PASSWORD_PROMPT_RE`) is gone.
- After a restart, `epoch:listTaskLogs` lists a workspace's logs from their headers and results, and `epoch:readTaskLog` reads one, by its file name only.

## 9. Display

The drawer's appearance is a pattern in [DESIGN.md](../apps/epoch/DESIGN.md); this is what it shows.

- **Two views, toggled (owner, 2026-10-18):**
  - **Summary**, the default: `info`, `warn` and `error` entries, in plain sentences. Only a warning, an error or a note for review carries a word tag (Warning, Error, For review). Progress collapses to one live line per step.
  - **Full log:** every entry, debug included, each with its time and level, for diagnosis.

- **Line:** `15:21:03Z  INFO   message`.
  - The time comes from `formatLogTime`. The level is written in text and also shown in colour: `error` danger, `warn` warning, `info` foreground, `debug` muted.
  - The label and step are shown as a muted prefix where present.
- **Bar:** the latest `info`/`warn`/`error` message, and "N errors · N warnings". It opens the drawer above it; nothing on the page moves.
- **Drawer:**
  - All, Warnings and Errors; Debug Detail (off by default); search over the message;
  - Following Latest, which becomes Jump to Latest when you scroll up;
  - Copy (the visible lines as text), Save As… (the whole task log as text with its header, or as `.ndjson`), Pop Out (a second window reading the same sanitized stream).
  - Header: "Times in UTC" and the task's start.
- **Failure banner:** names the backup, the step and the reason. Copy Details copies those, the backup's `error` and `warn` entries and the 20 entries before the first error. Debug entries are left out.

## 10. Decisions

Approved by the project owner on 2026-10-18 and recorded in
[decisions.md](decisions.md):

1. Raw tool and stage output is `debug` by source; failures come from the program's own `error` (§5).
2. The processor and orchestrator emit events when the app runs them, and human text on the command line (§8.2).
3. The sanitizer replaces only the classes in §6.3. Device Name and Display Name are not replaced, workstation paths become named roots, and markers name the dated label.
4. Safe to share covers secrets, device identifiers and the examiner's workstation. Its paths become named roots, and its host name, account name, process ids and command lines are not recorded (§6.1, §6.6). The owner added this caveat on 2026-10-18: what is stored and displayed is deliberate and justified. Evidence-derived content in debug output stays, because the log is case material (`0600`). Save As includes debug.
5. No log, no task. A write failure mid-task is shown and recorded, and the task continues (§7).
6. Pull uses the same contract and adopts it in U3 (§3).
7. The password tripwire (§6.2).
