-- 0001_init.sql
-- Core schema for the forensic pipeline.
-- Four tables, four responsibilities:
--   pipeline_runs / pipeline_stage_status  -> "did this run happen, and what succeeded"
--   ingested_files                         -> "what raw source files have we ever seen" (audit/chain of custody)
--   forensic_records                       -> "the normalized facts every extractor writes into"
--
-- Extractors NEVER get their own tables. Adding a new source_type is a code change
-- (new extractor + new contract validation), not a schema change.

-- gen_random_uuid() is built in (PostgreSQL 13 and later); no extension is needed.

-- ---------------------------------------------------------------------------
-- Run tracking: one row per invocation of the orchestrator against a backup.
-- ---------------------------------------------------------------------------
CREATE TABLE pipeline_runs (
    run_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    backup_source   TEXT NOT NULL,              -- path/identifier of the MVT backup this run is against
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ
);

-- Per-stage status within a run. This is what makes failure isolated instead
-- of fatal: the orchestrator writes to this table before/after every stage,
-- and the report reads it to know what's actually present vs. missing.
CREATE TABLE pipeline_stage_status (
    run_id          UUID NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
    stage_name      TEXT NOT NULL,               -- 'crash' | 'safari' | 'sms' | 'network' | 'gcloud' | 'report'
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
    error_message   TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    PRIMARY KEY (run_id, stage_name)
);

-- ---------------------------------------------------------------------------
-- Ingest ledger: immutable record of every source file ever processed.
-- Idempotency key is file_hash — re-running a stage against the same file
-- is a no-op, matching the SHA-256 dedup already proven out in the crash
-- extractor's original SQLite implementation.
-- ---------------------------------------------------------------------------
CREATE TABLE ingested_files (
    file_hash       TEXT PRIMARY KEY,            -- sha256 of the raw source file
    run_id          UUID NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL,
    file_name       TEXT NOT NULL,
    source_type     TEXT NOT NULL,               -- see contracts/ for the authoritative source_type enum
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw_payload     JSONB NOT NULL               -- untouched original — lets us re-derive fields if a parser's
                                                  -- normalization logic changes later, without re-touching the backup
);

CREATE INDEX idx_ingested_files_run ON ingested_files (run_id);
CREATE INDEX idx_ingested_files_source_type ON ingested_files (source_type);

-- ---------------------------------------------------------------------------
-- Normalized facts. Every extractor, regardless of language or source format,
-- writes rows here after mapping its domain into the shared envelope defined
-- in contracts/. This is the single table the report and any cross-domain
-- correlation query runs against.
-- ---------------------------------------------------------------------------
CREATE TABLE forensic_records (
    id              BIGSERIAL PRIMARY KEY,
    file_hash       TEXT NOT NULL REFERENCES ingested_files(file_hash),
    run_id          UUID NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
    incident_id     TEXT,                        -- correlation key when the source format has one (e.g. crash UUID)
    source_type     TEXT NOT NULL,
    event_time      TIMESTAMPTZ,                 -- normalized timestamp — THE field that enables cross-domain
                                                   -- correlation (crash vs. Safari vs. gcloud log, same time axis)
    bug_type        TEXT,                         -- crash-domain specific; null for other source types
    process_name    TEXT,
    pid             INTEGER,
    bundle_id       TEXT,
    fields          JSONB NOT NULL DEFAULT '{}'::jsonb  -- type-specific normalized fields, schema owned by
                                                          -- the extractor that wrote them (see contracts/)
);

CREATE INDEX idx_forensic_event_time ON forensic_records (event_time);
CREATE INDEX idx_forensic_source_type ON forensic_records (source_type);
CREATE INDEX idx_forensic_process ON forensic_records (process_name);
CREATE INDEX idx_forensic_run ON forensic_records (run_id);
-- GIN index for querying inside the type-specific fields blob without a schema migration per extractor
CREATE INDEX idx_forensic_fields_gin ON forensic_records USING GIN (fields);
