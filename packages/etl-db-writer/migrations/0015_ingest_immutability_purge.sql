-- 0015_ingest_immutability_purge.sql (VER-105)
--
-- Enforce R9 in PostgreSQL. Completed ledger units and their records cannot
-- be changed directly; a dedicated, non-login role is used only by the audited
-- evidence purge function.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verichron_epoch_purge_owner') THEN
        EXECUTE 'CREATE ROLE verichron_epoch_purge_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT';
    END IF;
END
$$;

ALTER ROLE verichron_epoch_purge_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

-- Move the mutable run attribution out of the immutable ledger row. A run ID
-- is an audit label, not evidence ownership (R7); it has no FK to pipeline_runs.
CREATE TABLE ingest_run_links (
    ingest_id BIGINT NOT NULL REFERENCES ingested_files (ingest_id),
    run_id    UUID NOT NULL,
    PRIMARY KEY (ingest_id, run_id)
);

DROP VIEW indicator_checks;

ALTER TABLE ingested_files DROP COLUMN produced_by_runs;

CREATE OR REPLACE FUNCTION reject_ingest_run_link_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_user <> 'verichron_epoch_purge_owner' OR TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'ingest_run_links is append-only (R7): % is not allowed', TG_OP
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END $$;

CREATE TRIGGER ingest_run_links_immutable
    BEFORE UPDATE OR DELETE ON ingest_run_links
    FOR EACH ROW EXECUTE FUNCTION reject_ingest_run_link_change();

CREATE OR REPLACE FUNCTION ingested_files_reject_completed_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.ingest_complete THEN
        IF TG_OP = 'UPDATE' OR current_user <> 'verichron_epoch_purge_owner' THEN
            RAISE EXCEPTION 'completed ingested_files rows are immutable (R9): % is not allowed', TG_OP
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER ingested_files_completed_immutable
    BEFORE UPDATE OR DELETE ON ingested_files
    FOR EACH ROW EXECUTE FUNCTION ingested_files_reject_completed_change();

CREATE OR REPLACE FUNCTION forensic_records_reject_completed_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    unit_complete BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT ingest_complete INTO unit_complete
        FROM public.ingested_files
        WHERE ingest_id = NEW.ingest_id
        FOR UPDATE;

        IF unit_complete THEN
            RAISE EXCEPTION 'forensic_records belonging to a completed ingest are immutable (R9): % is not allowed',
                TG_OP USING ERRCODE = 'restrict_violation';
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        FOR unit_complete IN
            SELECT ingest_complete
            FROM public.ingested_files
            WHERE ingest_id IN (OLD.ingest_id, NEW.ingest_id)
            ORDER BY ingest_id
            FOR UPDATE
        LOOP
            IF unit_complete THEN
                RAISE EXCEPTION 'forensic_records belonging to a completed ingest are immutable (R9): % is not allowed',
                    TG_OP USING ERRCODE = 'restrict_violation';
            END IF;
        END LOOP;
    ELSE
        SELECT ingest_complete INTO unit_complete
        FROM public.ingested_files
        WHERE ingest_id = OLD.ingest_id
        FOR UPDATE;

        IF unit_complete AND current_user <> 'verichron_epoch_purge_owner' THEN
            RAISE EXCEPTION 'forensic_records belonging to a completed ingest are immutable (R9): % is not allowed',
                TG_OP USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER forensic_records_completed_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON forensic_records
    FOR EACH ROW EXECUTE FUNCTION forensic_records_reject_completed_change();

-- Evidence events remain immutable. Add an explicit actor field for the
-- database principal that requested a purge, plus a purge event kind.
ALTER TABLE evidence_events
    ADD COLUMN actor TEXT;

ALTER TABLE evidence_events
    DROP CONSTRAINT evidence_events_kind_check,
    ADD CONSTRAINT evidence_events_kind_check CHECK (kind IN (
        'registered', 'location_added', 'derivative_registered',
        'verified', 'verify_failed', 'purged'
    ));

CREATE FUNCTION purge_evidence(p_evidence_id UUID, p_reason TEXT) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    deleted_records BIGINT;
    deleted_links BIGINT;
    deleted_ingests BIGINT;
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
            'deleted_ingests', deleted_ingests
        )
    );
END
$$;

GRANT SELECT, UPDATE ON public.evidence_items TO verichron_epoch_purge_owner;
GRANT SELECT, UPDATE, DELETE ON public.ingested_files TO verichron_epoch_purge_owner;
GRANT SELECT, DELETE ON public.ingest_run_links, public.forensic_records TO verichron_epoch_purge_owner;
GRANT INSERT ON public.evidence_events TO verichron_epoch_purge_owner;
GRANT USAGE, SELECT ON SEQUENCE public.evidence_events_event_id_seq TO verichron_epoch_purge_owner;

GRANT CREATE ON SCHEMA public TO verichron_epoch_purge_owner;
ALTER FUNCTION public.purge_evidence(UUID, TEXT) OWNER TO verichron_epoch_purge_owner;
REVOKE CREATE ON SCHEMA public FROM verichron_epoch_purge_owner;
REVOKE ALL ON FUNCTION public.purge_evidence(UUID, TEXT) FROM PUBLIC;

DO $$
BEGIN
    EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.purge_evidence(UUID, TEXT) TO %I',
        session_user
    );
END
$$;

-- Keep the shared indicator audit view on the immutable run-link relation.
CREATE VIEW indicator_checks AS
SELECT r.evidence_id,
       s.run_id,
       s.status,
       s.error_message,
       s.finished_at,
       s.indicator_set_id,
       iset.name          AS set_name,
       iset.set_hash,
       iset.registered_at AS set_registered_at,
       (SELECT max(i.modified) FROM public.indicators i WHERE i.set_id = s.indicator_set_id) AS newest_indicator,
       u.ingest_id,
       u.record_count     AS matches,
       u.raw_payload      AS summary
FROM public.pipeline_stage_status s
JOIN public.pipeline_runs r ON r.run_id = s.run_id
LEFT JOIN public.indicator_sets iset ON iset.set_id = s.indicator_set_id
LEFT JOIN LATERAL (
    SELECT f.ingest_id, f.record_count, f.raw_payload
    FROM public.ingested_files f
    WHERE s.status = 'succeeded'
      AND f.evidence_id = r.evidence_id
      AND f.source_type = 'indicator_match'
      AND f.indicator_set_id = s.indicator_set_id
      AND f.ingest_complete
      AND EXISTS (
          SELECT 1
          FROM public.ingest_run_links l
          WHERE l.ingest_id = f.ingest_id
            AND l.run_id = s.run_id
      )
    ORDER BY f.completed_at DESC
    LIMIT 1
) u ON TRUE
WHERE s.stage_name = 'indicator_match';

-- Created last, so migrate.py can tell this migration finished.
CREATE INDEX idx_ingest_run_links_run ON ingest_run_links (run_id, ingest_id);
