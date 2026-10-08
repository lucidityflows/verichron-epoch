-- 0005_run_registration.sql  (EPOCH-404)
--
-- What pre-flight evidence registration and evidence-keyed resume need.
--
-- run_completeness: THE predicate for whether a run is complete (R23). The
-- orchestrator's resume check, EPOCH-408's rerun and the UI all read it; none
-- of them may re-derive it. Defined in the database so the TypeScript and any
-- Python caller cannot disagree (R27).
--
--   running     the run has not finished (finished_at IS NULL)
--   incomplete  finished, and some stage failed, or some stage is still
--               pending/running -- the run closed without that stage
--               resolving (e.g. a killed process)
--   complete    finished, and every stage succeeded or was skipped
--
-- 'skipped' never makes a run incomplete: a disabled stage is recorded as
-- skipped so the run's stage list is whole, without turning the run red.

CREATE VIEW run_completeness AS
SELECT r.run_id,
       r.evidence_id,
       r.derivative_id,
       r.started_at,
       r.finished_at,
       CASE
           WHEN r.finished_at IS NULL THEN 'running'
           WHEN EXISTS (
               SELECT 1 FROM pipeline_stage_status s
               WHERE s.run_id = r.run_id
                 AND s.status IN ('failed', 'pending', 'running')
           ) THEN 'incomplete'
           ELSE 'complete'
       END AS state
FROM pipeline_runs r;

COMMENT ON VIEW run_completeness IS
    'The single run-completeness predicate (R23, EPOCH-404): running | incomplete | complete. Callers must not re-derive it.';

-- A derivative is identified, for registration, by the evidence it came from,
-- its kind, and where it lives: registering the same decrypt again finds the
-- existing row instead of minting a new one each run.
CREATE UNIQUE INDEX evidence_derivatives_identity
    ON evidence_derivatives (evidence_id, kind, path);
