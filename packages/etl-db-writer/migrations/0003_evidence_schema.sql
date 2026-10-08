-- 0003_evidence_schema.sql  (EPOCH-402)
--
-- Moves the ledger and the facts from "owned by a run" to "attached to
-- evidence". Rules this migration implements, from the architecture guide:
--
--   R6  Evidence identity is content-derived and scoped per evidence. The old
--       global `ingested_files.file_hash` PRIMARY KEY let byte-identical content
--       from two unrelated backups (e.g. a default empty alerts.json) collide:
--       whichever ingested it first satisfied dedup for every other evidence
--       item. Uniqueness is now (evidence_id, file_hash, source_type,
--       parser_version).
--   R7  A run is an audit event; it never owns facts. `run_id` leaves
--       ingested_files and forensic_records. `produced_by_runs` records every
--       run that attempted the unit and plays no part in dedup.
--   R8  A parser_version bump is append-only: a new row under the new version,
--       old rows untouched. "Latest" is chosen at read time (EPOCH-403).
--   R9  Nothing cascades from a run onto evidence or facts, and
--       evidence_events is immutable. (Row-level immutability of completed
--       ingests and the audited purge are EPOCH-412.)
--   R12 Each ingest records which payload it kept: full, summary or none.
--   R35 Each run records its contract version and tool versions.
--
-- GREENFIELD: ingested_files and forensic_records are dropped and rebuilt with
-- no backfill (decided in EPOCH-402). Rows from 0001/0002 are discarded.

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------

-- A device is keyed by HMAC-SHA256(UDID, per-install secret), never the raw
-- UDID, which must not reach the UI, reports or file names (EPOCH-407). The
-- key and the secret are computed by the registration step (EPOCH-404).
CREATE TABLE devices (
    device_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_key  TEXT NOT NULL UNIQUE CHECK (device_key ~ '^[0-9a-f]{64}$'),
    label       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per distinct backup content. content_root comes from the evidence
-- sidecar (EPOCH-401): sha256 of the canonical manifest.
CREATE TABLE evidence_items (
    evidence_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_root   TEXT NOT NULL UNIQUE CHECK (content_root ~ '^[0-9a-f]{64}$'),
    device_id      UUID NOT NULL REFERENCES devices (device_id),
    file_count     INTEGER NOT NULL CHECK (file_count >= 0),
    total_bytes    BIGINT NOT NULL CHECK (total_bytes >= 0),
    registered_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Where the same evidence has been seen. One backup at two paths is one
-- evidence row with two locations (EPOCH-404).
CREATE TABLE evidence_locations (
    location_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id    UUID NOT NULL REFERENCES evidence_items (evidence_id),
    host           TEXT NOT NULL,
    path           TEXT NOT NULL,
    first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (evidence_id, host, path)
);

-- A processing pass over evidence: a decrypt, or an mvt scan of a decrypted
-- pass. tool/params hold provenance (EPOCH-406).
CREATE TABLE evidence_derivatives (
    derivative_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id           UUID NOT NULL REFERENCES evidence_items (evidence_id),
    parent_derivative_id  UUID REFERENCES evidence_derivatives (derivative_id),
    kind                  TEXT NOT NULL CHECK (kind IN ('decrypted', 'mvt_results')),
    path                  TEXT NOT NULL,
    tool                  JSONB NOT NULL DEFAULT '{}'::jsonb,
    params                JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidence_derivatives_evidence ON evidence_derivatives (evidence_id);

-- Append-only custody log.
CREATE TABLE evidence_events (
    event_id     BIGSERIAL PRIMARY KEY,
    evidence_id  UUID NOT NULL REFERENCES evidence_items (evidence_id),
    kind         TEXT NOT NULL CHECK (kind IN (
                     'registered', 'location_added', 'derivative_registered',
                     'verified', 'verify_failed')),
    host         TEXT NOT NULL,
    detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidence_events_evidence ON evidence_events (evidence_id, occurred_at);

CREATE FUNCTION evidence_events_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'evidence_events is append-only (R9): % is not allowed', TG_OP
        USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER evidence_events_immutable
    BEFORE UPDATE OR DELETE ON evidence_events
    FOR EACH ROW EXECUTE FUNCTION evidence_events_reject_change();

-- ---------------------------------------------------------------------------
-- Runs: audit events pointing at the evidence they processed
-- ---------------------------------------------------------------------------

-- evidence_id / derivative_id stay nullable until EPOCH-404's pre-flight
-- registration sets them on every new run.
ALTER TABLE pipeline_runs
    ADD COLUMN evidence_id      UUID REFERENCES evidence_items (evidence_id),
    ADD COLUMN derivative_id    UUID REFERENCES evidence_derivatives (derivative_id),
    ADD COLUMN contract_version TEXT,
    ADD COLUMN tool_versions    JSONB;

-- Existing rows predate R35 and have no provenance to record; every run
-- created from here on must carry it.
UPDATE pipeline_runs SET contract_version = 'pre-0003', tool_versions = '{}'::jsonb;
ALTER TABLE pipeline_runs
    ALTER COLUMN contract_version SET NOT NULL,
    ALTER COLUMN tool_versions    SET NOT NULL;

CREATE INDEX idx_pipeline_runs_evidence ON pipeline_runs (evidence_id);

-- ---------------------------------------------------------------------------
-- Ledger and facts, rebuilt evidence-scoped (greenfield, no backfill)
-- ---------------------------------------------------------------------------

DROP TABLE forensic_records;
DROP TABLE ingested_files;

CREATE TABLE ingested_files (
    ingest_id         BIGSERIAL PRIMARY KEY,
    evidence_id       UUID NOT NULL REFERENCES evidence_items (evidence_id),
    derivative_id     UUID NOT NULL REFERENCES evidence_derivatives (derivative_id),
    file_hash         TEXT NOT NULL,
    source_type       TEXT NOT NULL,
    parser_version    INTEGER NOT NULL CHECK (parser_version >= 1),
    file_path         TEXT NOT NULL,
    file_name         TEXT NOT NULL,
    payload_kind      TEXT NOT NULL CHECK (payload_kind IN ('full', 'summary', 'none')),
    raw_payload       JSONB NOT NULL,
    -- Audit label only (R7): every run that attempted this unit, fresh or
    -- dedup hit. Not part of the unique key and not a foreign key, so deleting
    -- a run can never touch a fact (R9).
    produced_by_runs  UUID[] NOT NULL DEFAULT '{}',
    ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ingest_complete   BOOLEAN NOT NULL DEFAULT FALSE,
    record_count      INTEGER,
    completed_at      TIMESTAMPTZ,
    CONSTRAINT ingested_files_unit_unique
        UNIQUE (evidence_id, file_hash, source_type, parser_version),
    CONSTRAINT ingested_files_completion_consistent CHECK (
        (ingest_complete AND record_count IS NOT NULL AND completed_at IS NOT NULL)
        OR
        (NOT ingest_complete AND record_count IS NULL AND completed_at IS NULL)
    )
);

COMMENT ON COLUMN ingested_files.ingest_complete IS
    'TRUE only after this unit''s forensic_records were committed in the same transaction that set this flag. Dedup is gated on this, never on row existence.';
COMMENT ON COLUMN ingested_files.payload_kind IS
    'What raw_payload holds (R12): full = the parsed source, summary = metadata only, none = nothing kept. The database never claims fidelity it lacks.';

CREATE INDEX idx_ingested_files_derivative ON ingested_files (derivative_id);
CREATE INDEX idx_ingested_files_incomplete ON ingested_files (evidence_id) WHERE NOT ingest_complete;
-- The read-time "latest parser_version" rule (R8, EPOCH-403).
CREATE INDEX idx_ingested_files_latest
    ON ingested_files (evidence_id, file_hash, source_type, parser_version DESC);

CREATE TABLE forensic_records (
    id            BIGSERIAL PRIMARY KEY,
    ingest_id     BIGINT NOT NULL REFERENCES ingested_files (ingest_id),
    -- Denormalized from ingested_files for the evidence-scoped read path.
    evidence_id   UUID NOT NULL REFERENCES evidence_items (evidence_id),
    incident_id   TEXT,
    source_type   TEXT NOT NULL,
    event_time    TIMESTAMPTZ,
    bug_type      TEXT,
    process_name  TEXT,
    pid           INTEGER,
    bundle_id     TEXT,
    fields        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_forensic_ingest ON forensic_records (ingest_id);
CREATE INDEX idx_forensic_evidence_time ON forensic_records (evidence_id, event_time, id);
CREATE INDEX idx_forensic_source_type ON forensic_records (source_type);
CREATE INDEX idx_forensic_process ON forensic_records (process_name);
CREATE INDEX idx_forensic_fields_gin ON forensic_records USING GIN (fields);
