-- 0016_stage_item_failures.sql  (EPOCH-432)
--
-- Each item a stage could not ingest: a file for crash, an artifact table for
-- ileapp_bridge. Until now ETLRunResult.failures lived only in memory and
-- reached the database as the stage's whole stderr in error_message, so no one
-- could ask which items failed, why, or whether a later run completed them.
--
-- `item` is the path relative to the derivative the stage read (for example
-- `Retired/x.ips` or `_lava_artifacts.db#zalochat`). `file_hash` is the item's
-- sha256, the ledger's own identity (R6), when the item could be read; it is
-- NULL when it could not (an unopenable file, an artifact table that failed its
-- check). An item is still failing until a later completed unit of the same
-- evidence and source type has its hash, or, without a hash, sits at the same
-- path relative to its derivative (decided 2026-10-17; read side in
-- etl-db-reader's getStillFailing).
--
-- Append-only (R9): reasons can quote evidence content, so like the ledger the
-- rows carry their own evidence_id and only purge_evidence deletes them.
--
-- run_id and stage_name are audit labels, as in ingest_run_links (0015, R7):
-- no foreign key to pipeline_runs or pipeline_stage_status, so deleting a run
-- neither deletes these rows nor is refused because of them.

CREATE TABLE stage_item_failures (
    failure_id    BIGSERIAL PRIMARY KEY,
    run_id        UUID NOT NULL,
    stage_name    TEXT NOT NULL CHECK (btrim(stage_name) <> ''),
    evidence_id   UUID NOT NULL REFERENCES evidence_items (evidence_id),
    -- NULL only for a stage that reads an indicator set, not a derivative.
    derivative_id UUID,
    source_type   TEXT NOT NULL,
    item          TEXT NOT NULL,
    file_hash     TEXT,
    reason        TEXT NOT NULL,
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT stage_item_failures_derivative
        FOREIGN KEY (derivative_id, evidence_id) REFERENCES evidence_derivatives (derivative_id, evidence_id),
    CONSTRAINT stage_item_failures_item_relative
        CHECK (item <> '' AND left(item, 1) <> '/'),
    CONSTRAINT stage_item_failures_hash
        CHECK (file_hash IS NULL OR file_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT stage_item_failures_reason
        CHECK (btrim(reason) <> '')
);

CREATE OR REPLACE FUNCTION reject_stage_item_failure_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_user <> 'verichron_epoch_purge_owner' OR TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'stage_item_failures is append-only (R9): % is not allowed', TG_OP
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END $$;

CREATE TRIGGER stage_item_failures_immutable
    BEFORE UPDATE OR DELETE ON stage_item_failures
    FOR EACH ROW EXECUTE FUNCTION reject_stage_item_failure_change();

-- purge_evidence, as in 0015, now also deleting and counting the evidence's
-- failure rows. Replacing it keeps its owner and grants.
CREATE OR REPLACE FUNCTION purge_evidence(p_evidence_id UUID, p_reason TEXT) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    deleted_records BIGINT;
    deleted_links BIGINT;
    deleted_ingests BIGINT;
    deleted_failures BIGINT;
BEGIN
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'purge reason must not be empty'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    PERFORM 1
    FROM public.evidence_items
    WHERE evidence_id = p_evidence_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'evidence % does not exist', p_evidence_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    DELETE FROM public.ingest_run_links AS l
    USING public.ingested_files AS i
    WHERE l.ingest_id = i.ingest_id
      AND i.evidence_id = p_evidence_id;
    GET DIAGNOSTICS deleted_links = ROW_COUNT;

    DELETE FROM public.forensic_records AS f
    USING public.ingested_files AS i
    WHERE f.ingest_id = i.ingest_id
      AND i.evidence_id = p_evidence_id;
    GET DIAGNOSTICS deleted_records = ROW_COUNT;

    DELETE FROM public.ingested_files
    WHERE evidence_id = p_evidence_id;
    GET DIAGNOSTICS deleted_ingests = ROW_COUNT;

    DELETE FROM public.stage_item_failures
    WHERE evidence_id = p_evidence_id;
    GET DIAGNOSTICS deleted_failures = ROW_COUNT;

    INSERT INTO public.evidence_events (evidence_id, kind, host, actor, detail)
    VALUES (
        p_evidence_id,
        'purged',
        COALESCE(inet_client_addr()::TEXT, 'local'),
        session_user,
        jsonb_build_object(
            'reason', p_reason,
            'deleted_records', deleted_records,
            'deleted_run_links', deleted_links,
            'deleted_ingests', deleted_ingests,
            'deleted_item_failures', deleted_failures
        )
    );
END
$$;

GRANT SELECT, DELETE ON public.stage_item_failures TO verichron_epoch_purge_owner;

CREATE INDEX idx_stage_item_failures_run ON stage_item_failures (run_id, stage_name);

-- The evidence's items that are still failing (R27: the app and the report
-- ask the same question). For each item a stage of the evidence failed, its
-- latest failure, unless a unit of the same evidence and source type completed
-- after it: with the item's hash when the failure has one, else at the item's
-- path under that unit's derivative. A parser_version bump that newly fails an
-- item stays failing, since its earlier completion came before the failure.
CREATE VIEW still_failing_items AS
SELECT latest.failure_id, latest.evidence_id, latest.run_id, latest.stage_name, latest.derivative_id,
       latest.source_type, latest.item, latest.file_hash, latest.reason, latest.recorded_at
FROM (
    SELECT DISTINCT ON (s.evidence_id, s.stage_name, s.item) s.*
    FROM public.stage_item_failures s
    ORDER BY s.evidence_id, s.stage_name, s.item, s.recorded_at DESC, s.failure_id DESC
) latest
WHERE NOT EXISTS (
    SELECT 1
    FROM public.ingested_files f
    LEFT JOIN public.evidence_derivatives d ON d.derivative_id = f.derivative_id
    WHERE f.evidence_id = latest.evidence_id
      AND f.source_type = latest.source_type
      AND f.ingest_complete
      AND f.completed_at > latest.recorded_at
      AND CASE
              WHEN latest.file_hash IS NOT NULL THEN f.file_hash = latest.file_hash
              ELSE f.file_path = d.path || '/' || latest.item
          END
);

-- Created last, so migrate.py can tell this migration finished.
CREATE INDEX idx_stage_item_failures_evidence ON stage_item_failures (evidence_id, stage_name, item, recorded_at);
