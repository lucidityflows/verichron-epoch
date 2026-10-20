-- 0020_run_display_zone.sql  (EPOCH-560)
--
-- A run records the zone its report shows times in, with the rest of its
-- configuration (R35): UTC, the default, or the named zone the examiner chose
-- in Settings ("America/Chicago"). Times are stored in UTC (R11); the zone
-- changes only how the report shows them. The report reads it from here, so
-- the report and the record can't disagree.
--
-- The orchestrator accepts only UTC or a named IANA zone
-- (packages/contracts/ts/displayZone.ts); this checks only that one is there.
--
-- Rows created before this migration record no zone, and none is guessed:
-- development data is disposable. A database with runs is refused; recreate
-- it and analyze again.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pipeline_runs) THEN
        RAISE EXCEPTION 'the database holds runs from before EPOCH-560, which record no display zone; '
            'recreate the development database and analyze again';
    END IF;
END
$$;

ALTER TABLE pipeline_runs
    ADD COLUMN display_zone TEXT NOT NULL CONSTRAINT pipeline_runs_display_zone_present CHECK (btrim(display_zone) <> '');
