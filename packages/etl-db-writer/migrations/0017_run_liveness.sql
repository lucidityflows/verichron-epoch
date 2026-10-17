-- 0017_run_liveness.sql  (EPOCH-435, EPOCH-561)
--
-- A run records which process runs it and, once it ends, why. A run that ends
-- without the orchestrator finishing it (cancelled, stalled, crashed, or left
-- by an app that closed) is closed by setting its end, never by rewriting its
-- stage rows: a stage that never finished keeps the status it had, and
-- run_completeness reports the run incomplete on its own (R9's direction,
-- R23).
--
--   host, pid      the orchestrator process that created the run, so a run
--                  whose process is gone can be found and closed as
--                  abandoned. A reused pid can only make a dead run look
--                  alive (it is closed later), never close a live one.
--   ended_reason   completed | cancelled | timeout | crashed | abandoned;
--                  set exactly when finished_at is.
--   ended_detail   what the closer knew about why, e.g. the orchestrator's
--                  own error for a crash.
--
-- Rows created before this migration have no process or end reason, and none
-- is guessed: development data is disposable (EPOCH-414's precedent). A
-- database with runs is refused; recreate it and import again.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pipeline_runs) THEN
        RAISE EXCEPTION 'the database holds runs from before EPOCH-435, which record no process or end reason; '
            'recreate the development database and import again';
    END IF;
END
$$;

ALTER TABLE pipeline_runs
    ADD COLUMN host TEXT NOT NULL CHECK (btrim(host) <> ''),
    ADD COLUMN pid INTEGER NOT NULL CHECK (pid > 0),
    ADD COLUMN ended_reason TEXT
        CHECK (ended_reason IN ('completed', 'cancelled', 'timeout', 'crashed', 'abandoned')),
    ADD COLUMN ended_detail TEXT,
    ADD CONSTRAINT pipeline_runs_end_has_reason CHECK ((finished_at IS NULL) = (ended_reason IS NULL));

-- The unfinished runs a host's sweep checks for a live process.
CREATE INDEX idx_pipeline_runs_unfinished ON pipeline_runs (host, pid) WHERE finished_at IS NULL;

-- EPOCH-561: the fact-writing stages whose latest attempt for the evidence
-- was interrupted. For each evidence and stage that writes facts (it declares
-- a parser version), the latest run that attempted it (a skipped stage didn't
-- attempt it); reported when that run ended interrupted with the stage still
-- pending or running. A stage interrupted this way recorded none of the items
-- it failed, so the app and the report must say so (R27). A run still going
-- is not reported: its end isn't known yet.
CREATE VIEW interrupted_stages AS
SELECT latest.evidence_id, latest.stage_name, latest.run_id, latest.status,
       latest.ended_reason, latest.ended_detail, latest.finished_at
FROM (
    SELECT DISTINCT ON (r.evidence_id, s.stage_name)
           r.evidence_id, s.stage_name, s.run_id, s.status,
           r.ended_reason, r.ended_detail, r.finished_at
    FROM public.pipeline_stage_status s
    JOIN public.pipeline_runs r ON r.run_id = s.run_id
    WHERE r.evidence_id IS NOT NULL
      AND s.parser_version IS NOT NULL
      AND s.status <> 'skipped'
    ORDER BY r.evidence_id, s.stage_name, r.started_at DESC, r.run_id DESC
) latest
WHERE latest.status IN ('pending', 'running')
  AND latest.ended_reason IN ('cancelled', 'timeout', 'crashed', 'abandoned');
