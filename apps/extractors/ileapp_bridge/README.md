# ileapp_bridge stage

Turns [iLEAPP](https://github.com/abrignoni/iLEAPP)'s results into
`ileapp_record` facts. It reads the **iLEAPP output** derivative
(`"reads": "ileapp_output"`); order 20. It follows the
[stage contract](../../../packages/contracts/EXTRACTOR_CONTRACT.md).

The processor runs iLEAPP, not this stage (EPOCH-416): it leaves one report per
backup at the output path declared in `workspace.json`, marked with
`.ileapp_ok`, and the orchestrator registers it and passes its directory as
`--derivative-path`. This stage reads that directory and nothing else.

> **Known issues** are ticketed and ordered under VER-24. Its tests use
> recorded LAVA output (`test_integration.py`); CI doesn't run the real iLEAPP
> (EPOCH-482).

## How it works

It reads exactly two files of the report (EPOCH-461): `_lava_artifacts.db`,
iLEAPP's structured results with one table per artifact, and `_lava_data.lava`,
the manifest describing each table. The TSV/CSV exports and HTML report are
presentation formats built from the same data, and `data/` and `media/` are
iLEAPP's copies of the input, so none of them is read.

1. `lava.py` checks the manifest (schema version 2, `processing_status`
   `Complete`) and that its artifact tables and the database's are the same
   set. Either failing stops the stage.
2. For each artifact it reads the table, read-only and immutable, so the
   derivative's bytes never change. The row count must equal the manifest's
   `record_count`, and every column must have its own header in its
   `column_map`; otherwise that artifact fails and the rest continue.
3. `main.py` files each artifact as one `ingest()` unit, so all of its rows
   commit or none do. The unit's identity is a sha256 over everything its
   records carry: the artifact's name, module, category and source path, its
   columns and headers in order, its declared types in declared order (the
   first `datetime` is `event_time`) and its rows. It is recorded as
   `_lava_artifacts.db#<table>`. An unchanged artifact from a re-run of
   iLEAPP is a dedup hit; any change is a new unit. The payload is a `summary`: the artifact, its counts and a sample
   of rows. An artifact with no rows is a unit too, completed with 0 records,
   so the evidence shows it was examined and later runs skip it.

**Time.** iLEAPP's plugins convert their sources' time formats themselves and
declare the result `datetime`, stored as Unix UTC seconds. `event_time` is the
artifact's **first declared** `datetime` column. An artifact with none is
untimed; a value that isn't Unix seconds gives `event_time = null`, keeps its
raw value in `fields`, and is counted in the stage's notes (R11). No column is
chosen or parsed by name.

**Warnings (EPOCH-420).** The stage writes notes to stderr. When it succeeds,
the orchestrator stores that stderr in the stage's `warnings`; if the stage
fails, stderr is stored as its error message instead.

**iLEAPP's output is checked, not trusted (R36, EPOCH-511).**

- Every declared time before 2007-06-29 (the first iPhone) or after the run is
  kept as iLEAPP gives it, counted in the stage's notes per artifact and
  column, and marked on its record in `fields.time_review` (column, time,
  check). The report lists every marked column for review, not only
  `event_time`.
- A defect registered for this iLEAPP version in
  `packages/contracts/tool_defects/iLEAPP.json` is corrected. The version is
  the one iLEAPP records in its manifest (`parser_info.leapp_version`), so a
  report that doesn't record it as a non-empty string fails the stage. A
  defect applies only to the module, artifacts and columns it names. The row
  keeps iLEAPP's value
  under its header, `event_time` takes the corrected value, and `fields.corrections`
  lists each correction (defect, column, original, corrected, resolution).
  A registered column the artifact lacks fails that artifact. Corrections are
  not part of the unit's identity: an entry ships with a bump of this stage's
  `parserVersion` (`applied_from`), which supersedes the uncorrected facts.
- The first entry, `ILEAPP-0001` (EPOCH-510): the `uberClient` plugin divides
  Uber's Unix seconds by 1,000 once too often in Uber - Place Search Hits and
  Uber - Cached Locations. iLEAPP keeps whole seconds after dividing, so the
  corrected time is exact to 1,000 seconds.

## `fields`

- every column of the row, under **iLEAPP's original header** (e.g. `Visit
  Timestamp`, `URL`). Binary values, text holding NUL and infinite numbers
  (which `jsonb` can't store) are kept exactly as `{"$encoded": "hex" |
  "utf8-hex" | "float", "value": ...}` (`lava.decode_value` returns the
  original), and counted in the stage's notes;
- `engine`: always `"iLEAPP"`;
- `source_artifact`, `module`, `category`: the artifact as the manifest names it;
- `source_path`: the input file the artifact was read from, relative to the
  evidence;
- `corrections`, only on a row a registered tool defect corrected, and
  `time_review`, only on a row with a declared time outside the device era
  (see above).

A header equal to one of these seven keys fails its artifact rather than being
overwritten. The shape otherwise varies with the iLEAPP module.

## Test

```bash
uv run pytest apps/extractors/ileapp_bridge
```

**Known issues:**

No open issues are listed here. The previously reported NUL/NaN handling and
bounded-memory ingestion are implemented in `lava.py` and `main.py` (EPOCH-418).
