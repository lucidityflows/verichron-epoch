-- 0013_indicator_matching.sql  (EPOCH-491, EPOCH-493)
--
-- Indicator matching is a pipeline stage whose input is a registered
-- indicator set, not a derivative (decided 2026-10-15, project owner):
--
--   * A unit of facts is read from exactly one input: a derivative of the
--     evidence (every extractor until now) or an indicator set (the match
--     stage). The match unit records the set; each match's fields name the
--     fact it matched, and so the derivative that fact came from (R7, R16).
--   * Each stage row records the set it checked, beside the derivative it
--     read, so a run states which set it used and the orchestrator's resume
--     check can tell a newer set from an old one (R22).
--
-- The registry gains what results must state (EPOCH-493): a name for each set
-- and each indicator's STIX `modified` time, whose newest value dates the set
-- (D5). Sets registered before this migration have neither and are refused:
-- development data is disposable, so clear the registry and register them
-- again (TRUNCATE does not fire the append-only triggers).

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM indicator_sets) THEN
        RAISE EXCEPTION 'indicator_sets holds sets registered before EPOCH-491, without a name or indicator times. '
            'Run TRUNCATE indicators, indicator_set_files, indicator_sets, indicator_file_contents; '
            'then migrate and register the sets again';
    END IF;
END
$$;

ALTER TABLE indicator_sets
    ADD COLUMN name TEXT NOT NULL CONSTRAINT indicator_sets_name_present CHECK (btrim(name) <> '');

-- STIX 2.1 requires `modified` on every indicator.
ALTER TABLE indicators
    ADD COLUMN modified TIMESTAMPTZ NOT NULL;

ALTER TABLE ingested_files
    ALTER COLUMN derivative_id DROP NOT NULL,
    ADD COLUMN indicator_set_id UUID REFERENCES indicator_sets (set_id),
    ADD CONSTRAINT ingested_files_one_input
        CHECK ((derivative_id IS NULL) <> (indicator_set_id IS NULL));

ALTER TABLE pipeline_stage_status
    ADD COLUMN indicator_set_id UUID REFERENCES indicator_sets (set_id);

-- What the report and the app both say about indicator checks (EPOCH-493),
-- so the two read one query (R27).
--
-- indicator_checks: every run's indicator-match stage, with the set it checked
-- and, for a check that succeeded, the unit it completed or found already done
-- (the run is on the unit's produced_by_runs, R7). newest_indicator dates the
-- set (D5).
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
       (SELECT max(i.modified) FROM indicators i WHERE i.set_id = s.indicator_set_id) AS newest_indicator,
       u.ingest_id,
       u.record_count     AS matches,
       u.raw_payload      AS summary
FROM pipeline_stage_status s
JOIN pipeline_runs r ON r.run_id = s.run_id
LEFT JOIN indicator_sets iset ON iset.set_id = s.indicator_set_id
LEFT JOIN LATERAL (
    SELECT f.ingest_id, f.record_count, f.raw_payload
    FROM ingested_files f
    WHERE s.status = 'succeeded'
      AND f.evidence_id = r.evidence_id
      AND f.source_type = 'indicator_match'
      AND f.indicator_set_id = s.indicator_set_id
      AND f.ingest_complete
      AND s.run_id = ANY (f.produced_by_runs)
    ORDER BY f.completed_at DESC
    LIMIT 1
) u ON TRUE
WHERE s.stage_name = 'indicator_match';

-- indicator_set_sources: a set's files grouped by where they came from and
-- their licence, for the attribution both state (never typed by hand).
CREATE VIEW indicator_set_sources AS
SELECT set_id, source_repository, source_commit, licence, redistributable,
       count(*) AS files, max(downloaded_on) AS downloaded_on
FROM indicator_set_files
GROUP BY set_id, source_repository, source_commit, licence, redistributable;

-- Created last, so migrate.py can tell this migration finished.
CREATE INDEX idx_ingested_files_indicator_set ON ingested_files (indicator_set_id);
