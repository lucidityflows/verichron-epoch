-- 0022_record_entities.sql  (EPOCH-581)
--
-- What each record mentions, by kind: the domains, URLs, apps, processes,
-- email addresses, phone numbers, IP addresses, Wi-Fi networks and access
-- points, and Bluetooth devices, each read from a named field by a declared
-- rule (packages/contracts/entity_rules.json). Stored, not derived at read
-- time: read from the JSON, each count over 200,000 records took over a
-- second (2026-10-20), and the Timeline (EPOCH-580) reads a device's whole life.
--
-- 1. A unit can be read from the evidence's facts. Until now a unit was read
--    from a derivative or an indicator set (0013). The entities stage reads
--    one completed fact unit at a time and writes one unit for it, which
--    names that fact unit (source_ingest_id). A unit still has exactly one
--    input. Entity units hold no forensic_records: their record_count is 0,
--    so no count of records includes them, and their payload says what was
--    read and what wasn't.
--
-- 2. record_entities: one row per (record, kind, role, value). The role is
--    the field the rule read ("Imported by Bundle ID"), so the kinds stay few
--    and the meaning stays with the record. Only the normalized value is
--    kept; the value as stored is the record's own (minimized, R12). A row
--    can only name a record of the unit its unit was read from, and, like a
--    record, can't change once its unit completed (R9).
--
-- 3. current_record_entities: the rows of current entity units whose record
--    is current, so a newer rule set (R8) or a newer parse of the facts
--    replaces them, and the purge removes them with their evidence.
--
-- 4. What the rules read and what they don't, from each current unit's
--    payload, for the app and the report alike.

-- 1. A unit read from a fact unit -----------------------------------------------

ALTER TABLE ingested_files
    ADD COLUMN source_ingest_id BIGINT,
    ADD CONSTRAINT ingested_files_source_same_evidence
        FOREIGN KEY (source_ingest_id, evidence_id) REFERENCES ingested_files (ingest_id, evidence_id),
    DROP CONSTRAINT ingested_files_one_input,
    ADD CONSTRAINT ingested_files_one_input CHECK (
        num_nonnulls(derivative_id, indicator_set_id, source_ingest_id) = 1
    );

COMMENT ON COLUMN ingested_files.source_ingest_id IS
    'The fact unit an entity unit was read from (EPOCH-581); NULL for every other unit.';

CREATE INDEX idx_ingested_files_source ON ingested_files (source_ingest_id) WHERE source_ingest_id IS NOT NULL;

-- 2. record_entities -----------------------------------------------------------

CREATE TABLE record_entities (
    id               BIGSERIAL PRIMARY KEY,
    ingest_id        BIGINT NOT NULL,
    evidence_id      UUID NOT NULL REFERENCES evidence_items (evidence_id),
    record_id        BIGINT NOT NULL REFERENCES forensic_records (id),
    kind             TEXT NOT NULL CHECK (btrim(kind) <> ''),
    role             TEXT NOT NULL CHECK (btrim(role) <> ''),
    normalized_value TEXT NOT NULL CHECK (normalized_value <> ''),
    -- The value's sha256, set by the insert trigger below. A URL can be longer
    -- than a B-tree index entry may be (2,704 bytes; measured on a real backup,
    -- 2026-10-20), so keys and lookups use the hash, and a lookup also compares
    -- the value itself.
    value_hash       BYTEA NOT NULL,
    CONSTRAINT record_entities_unit_same_evidence
        FOREIGN KEY (ingest_id, evidence_id) REFERENCES ingested_files (ingest_id, evidence_id),
    CONSTRAINT record_entities_once UNIQUE (ingest_id, record_id, kind, role, value_hash)
);

CREATE OR REPLACE FUNCTION record_entities_check_and_reject_completed_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    unit_complete BOOLEAN;
    unit_source BIGINT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT ingest_complete, source_ingest_id INTO unit_complete, unit_source
        FROM public.ingested_files
        WHERE ingest_id = NEW.ingest_id
        FOR UPDATE;

        IF unit_complete THEN
            RAISE EXCEPTION 'record_entities belonging to a completed ingest are immutable (R9): % is not allowed',
                TG_OP USING ERRCODE = 'restrict_violation';
        END IF;
        NEW.value_hash := sha256(convert_to(NEW.normalized_value, 'UTF8'));
        -- An entity names a record of the fact unit its own unit was read from (R7).
        IF unit_source IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.forensic_records f
            WHERE f.id = NEW.record_id AND f.ingest_id = unit_source AND f.evidence_id = NEW.evidence_id
        ) THEN
            RAISE EXCEPTION 'record % is not a record of the unit this entity unit was read from', NEW.record_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'record_entities are never updated (R9)' USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT ingest_complete INTO unit_complete
    FROM public.ingested_files
    WHERE ingest_id = OLD.ingest_id
    FOR UPDATE;

    IF unit_complete AND current_user <> 'verichron_epoch_purge_owner' THEN
        RAISE EXCEPTION 'record_entities belonging to a completed ingest are immutable (R9): % is not allowed',
            TG_OP USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END $$;

CREATE TRIGGER record_entities_completed_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON record_entities
    FOR EACH ROW EXECUTE FUNCTION record_entities_check_and_reject_completed_change();

-- For counts by kind and value, and for "the records that mention this value".
CREATE INDEX idx_record_entities_value ON record_entities (evidence_id, kind, value_hash);
CREATE INDEX idx_record_entities_record ON record_entities (record_id);
CREATE INDEX idx_record_entities_ingest ON record_entities (ingest_id);

-- 3. The current entities ------------------------------------------------------

CREATE VIEW current_record_entities AS
SELECT e.id,
       e.evidence_id,
       e.ingest_id,
       e.record_id,
       e.kind,
       e.role,
       e.normalized_value,
       e.value_hash,
       r.source_type,
       r.source_artifact,
       r.event_time
FROM record_entities e
JOIN ingested_files u ON u.ingest_id = e.ingest_id AND u.ingest_complete
JOIN current_forensic_records r ON r.id = e.record_id
WHERE NOT EXISTS (
    SELECT 1
    FROM ingested_files newer
    WHERE newer.evidence_id = u.evidence_id
      AND newer.file_hash = u.file_hash
      AND newer.source_type = u.source_type
      AND newer.parser_version > u.parser_version
      AND newer.ingest_complete
);

COMMENT ON VIEW current_record_entities IS
    'Default entity read: rows of the latest completed entity unit per fact unit, whose record is current. R8, R27.';

-- 4. What the rules read, and what they don't -----------------------------------
--
-- Each current entity unit of a current fact unit, with what its payload says
-- (entity_stage.py): the app and the report state coverage from these two
-- views, so they can't disagree (R27).

CREATE VIEW current_entity_units AS
SELECT u.ingest_id,
       u.evidence_id,
       u.source_ingest_id,
       s.source_type,
       -- From the entity unit's own payload: an iLEAPP unit's holds sample
       -- records, and reading it per row took 2.4 s on a real backup.
       u.raw_payload -> 'source' ->> 'artifact' AS artifact,
       u.raw_payload                            AS summary
FROM ingested_files u
JOIN ingested_files s ON s.ingest_id = u.source_ingest_id AND s.ingest_complete
WHERE u.source_type = 'entity'
  AND u.ingest_complete
  AND NOT EXISTS (
      SELECT 1 FROM ingested_files newer
      WHERE newer.evidence_id = u.evidence_id AND newer.file_hash = u.file_hash
        AND newer.source_type = u.source_type AND newer.parser_version > u.parser_version
        AND newer.ingest_complete)
  AND NOT EXISTS (
      SELECT 1 FROM ingested_files newer
      WHERE newer.evidence_id = s.evidence_id AND newer.file_hash = s.file_hash
        AND newer.source_type = s.source_type AND newer.parser_version > s.parser_version
        AND newer.ingest_complete);

-- entity_unread_fields: each field that held values and that no rule reads,
-- per source (an iLEAPP artifact, or crash reports), with how many records
-- held a value in it, and how many of those values have each shape hint
-- (`shaped`, {hint: values}). A hint ranks a field for review; it never
-- decides a value's kind.
CREATE VIEW entity_unread_fields AS
WITH fields AS (
    SELECT c.evidence_id, c.source_type, c.artifact, f.key AS field, f.value AS entry
    FROM current_entity_units c
    CROSS JOIN LATERAL jsonb_each(c.summary -> 'unread_fields') f
),
totals AS (
    SELECT evidence_id, source_type, artifact, field, sum((entry ->> 'records')::bigint) AS records
    FROM fields
    GROUP BY evidence_id, source_type, artifact, field
),
hints AS (
    SELECT evidence_id, source_type, artifact, field, jsonb_object_agg(hint, n ORDER BY hint) AS shaped
    FROM (
        SELECT f.evidence_id, f.source_type, f.artifact, f.field, h.key AS hint, sum(h.value::bigint) AS n
        FROM fields f
        CROSS JOIN LATERAL jsonb_each_text(f.entry -> 'shaped') h
        GROUP BY f.evidence_id, f.source_type, f.artifact, f.field, h.key
    ) per_hint
    GROUP BY evidence_id, source_type, artifact, field
)
SELECT t.evidence_id,
       t.source_type,
       t.artifact,
       t.field,
       t.records,
       coalesce(h.shaped, '{}'::jsonb) AS shaped
FROM totals t
LEFT JOIN hints h
       ON h.evidence_id = t.evidence_id AND h.source_type = t.source_type
      AND h.artifact IS NOT DISTINCT FROM t.artifact AND h.field = t.field;

-- entity_rule_reads: what each rule read, per source: values of its kind and
-- of the kind each also yields, values that didn't fit, values of another kind.
CREATE VIEW entity_rule_reads AS
SELECT c.evidence_id,
       c.source_type,
       c.artifact,
       r ->> 'kind'                          AS kind,
       r ->> 'field'                         AS field,
       sum((r ->> 'read')::bigint)           AS read,
       sum((r ->> 'also_read')::bigint)      AS also_read,
       sum((r ->> 'unreadable')::bigint)     AS unreadable,
       sum((r ->> 'also_unreadable')::bigint) AS also_unreadable,
       sum((r ->> 'other_kind')::bigint)     AS other_kind
FROM current_entity_units c
CROSS JOIN LATERAL jsonb_array_elements(c.summary -> 'rules') r
GROUP BY c.evidence_id, c.source_type, c.artifact, r ->> 'kind', r ->> 'field';

-- purge_evidence, as in 0016, now also deleting and counting the evidence's
-- entities, before the records they name. Replacing it keeps its owner and grants.
CREATE OR REPLACE FUNCTION purge_evidence(p_evidence_id UUID, p_reason TEXT) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    deleted_entities BIGINT;
    deleted_records BIGINT;
    deleted_links BIGINT;
    deleted_ingests BIGINT;
    deleted_entity_units BIGINT;
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

    DELETE FROM public.record_entities
    WHERE evidence_id = p_evidence_id;
    GET DIAGNOSTICS deleted_entities = ROW_COUNT;

    DELETE FROM public.forensic_records AS f
    USING public.ingested_files AS i
    WHERE f.ingest_id = i.ingest_id
      AND i.evidence_id = p_evidence_id;
    GET DIAGNOSTICS deleted_records = ROW_COUNT;

    -- Entity units name the fact units they were read from: delete them first.
    DELETE FROM public.ingested_files
    WHERE evidence_id = p_evidence_id AND source_ingest_id IS NOT NULL;
    GET DIAGNOSTICS deleted_entity_units = ROW_COUNT;

    DELETE FROM public.ingested_files
    WHERE evidence_id = p_evidence_id;
    GET DIAGNOSTICS deleted_ingests = ROW_COUNT;
    deleted_ingests := deleted_ingests + deleted_entity_units;

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
            'deleted_entities', deleted_entities,
            'deleted_run_links', deleted_links,
            'deleted_ingests', deleted_ingests,
            'deleted_item_failures', deleted_failures
        )
    );
END
$$;

GRANT SELECT, DELETE ON public.record_entities TO verichron_epoch_purge_owner;

-- The runtime reads entities; the writer inserts them, and deletes an
-- abandoned unit's orphaned rows when it reclaims the unit (db_writer.py).
GRANT SELECT, INSERT, DELETE ON public.record_entities TO verichron_epoch_runtime;
GRANT USAGE, SELECT ON SEQUENCE public.record_entities_id_seq TO verichron_epoch_runtime;
GRANT SELECT ON public.current_record_entities, public.current_entity_units, public.entity_unread_fields,
    public.entity_rule_reads TO verichron_epoch_runtime;

-- Created last, so migrate.py can tell this migration finished.
CREATE INDEX idx_record_entities_kind ON record_entities (evidence_id, kind, record_id);
