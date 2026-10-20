-- 0021_record_reads.sql  (EPOCH-411, EPOCH-556)
--
-- What Forensic Records needs to read the evidence's facts honestly: every
-- source type registered with its tier (R10), and indexes for the filters,
-- counts and search it runs on the database, never on loaded rows (R25).
--
-- 1. The tier registry. R10 requires every source type to be registered as
--    Observed, Tool judgement or Lead. The registry is a table, so both
--    languages read one list (R2, R27), and forensic_records refers to it, so
--    a record of an unregistered source type can't be written. A Lead (an
--    AI-assisted lead, EPOCH-442) never appears among the facts.
--
-- 2. What iLEAPP records about where each row came from, its artifact,
--    module and category, as columns generated from `fields` when a record
--    is written. Read from the JSON, each count over 200,000 records took
--    about a second (measured 2026-10-20); as columns they are indexed and
--    read like source_type. Their one source stays `fields`.
--
-- 3. Search across every field's value, by trigram (pg_trgm), over the values
--    only, so a search for "URL" doesn't match every record that has a field
--    of that name.
--
-- 4. "Used by": the indicator matches that cite a record
--    (fields.fact.record_id).

-- 1. The tier registry -------------------------------------------------------

CREATE TABLE source_type_tiers (
    source_type TEXT PRIMARY KEY,
    tier        TEXT NOT NULL CHECK (tier IN ('observed', 'tool_judgement', 'lead'))
);

-- Every value of the canonical schema's source_type enum
-- (packages/contracts/normalized-record.schema.json);
-- scripts/test_record_reads.py fails when the two differ.
INSERT INTO source_type_tiers (source_type, tier) VALUES
    ('crash_report', 'observed'),
    ('siri_feedback', 'observed'),
    ('sfa_analytics', 'observed'),
    ('xp_amp_telemetry', 'observed'),
    ('safari_history', 'observed'),
    ('sms_attachment', 'observed'),
    ('network_usage', 'observed'),
    ('gcloud_log', 'observed'),
    ('syslog_line', 'observed'),
    ('ileapp_record', 'observed'),
    ('indicator_match', 'tool_judgement'),
    ('llm_flagged_anomaly', 'lead');

DO $$
DECLARE
    unregistered TEXT;
BEGIN
    SELECT string_agg(DISTINCT f.source_type, ', ') INTO unregistered
    FROM forensic_records f
    WHERE NOT EXISTS (SELECT 1 FROM source_type_tiers t WHERE t.source_type = f.source_type);
    IF unregistered IS NOT NULL THEN
        RAISE EXCEPTION 'forensic_records holds source types with no registered tier (R10): %. '
            'Recreate the development database and analyze again', unregistered;
    END IF;
END
$$;

ALTER TABLE forensic_records
    ADD CONSTRAINT forensic_records_source_type_registered
        FOREIGN KEY (source_type) REFERENCES source_type_tiers (source_type);

-- 2. The artifact, module and category as columns -----------------------------

ALTER TABLE forensic_records
    ADD COLUMN source_artifact TEXT GENERATED ALWAYS AS (fields ->> 'source_artifact') STORED,
    ADD COLUMN module          TEXT GENERATED ALWAYS AS (fields ->> 'module') STORED,
    ADD COLUMN category        TEXT GENERATED ALWAYS AS (fields ->> 'category') STORED;

CREATE INDEX idx_forensic_evidence_artifact ON forensic_records (evidence_id, source_artifact);
CREATE INDEX idx_forensic_evidence_module ON forensic_records (evidence_id, module);
CREATE INDEX idx_forensic_evidence_category ON forensic_records (evidence_id, category);

-- The read views carry them, after their existing columns (0004).
CREATE OR REPLACE VIEW forensic_records_history AS
SELECT f.id,
       f.ingest_id,
       f.evidence_id,
       i.derivative_id,
       i.file_hash,
       i.parser_version,
       f.incident_id,
       f.source_type,
       f.event_time,
       f.bug_type,
       f.process_name,
       f.pid,
       f.bundle_id,
       f.fields,
       f.source_artifact,
       f.module,
       f.category
FROM forensic_records f
JOIN ingested_files i ON i.ingest_id = f.ingest_id
WHERE i.ingest_complete;

CREATE OR REPLACE VIEW current_forensic_records AS
SELECT h.*
FROM forensic_records_history h
JOIN ingested_files i ON i.ingest_id = h.ingest_id
WHERE NOT EXISTS (
    SELECT 1
    FROM ingested_files newer
    WHERE newer.evidence_id = i.evidence_id
      AND newer.file_hash = i.file_hash
      AND newer.source_type = i.source_type
      AND newer.parser_version > i.parser_version
      AND newer.ingest_complete
);

-- 3. Search across field values ----------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The record's values as one text, each separated by a newline; nested
-- values (an encoded value, a correction) as their JSON text. Keys are left
-- out. IMMUTABLE, so it can be indexed.
CREATE FUNCTION record_values_text(fields JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT coalesce(string_agg(value, E'\n'), '') FROM jsonb_each_text(fields)
$$;

CREATE INDEX idx_forensic_values_trgm ON forensic_records USING GIN (record_values_text(fields) gin_trgm_ops);

-- 4. The matches that cite a record ------------------------------------------

CREATE INDEX idx_forensic_match_cites ON forensic_records (((fields -> 'fact' ->> 'record_id')::bigint))
    WHERE source_type = 'indicator_match';

-- The runtime reads the registry and calls the search function (0018).
GRANT SELECT ON public.source_type_tiers TO verichron_epoch_runtime;
GRANT EXECUTE ON FUNCTION public.record_values_text(JSONB) TO verichron_epoch_runtime;
