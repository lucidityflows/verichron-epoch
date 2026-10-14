-- 0010_stage_warnings.sql  (EPOCH-420)
--
-- What a stage wrote to stderr when it succeeded: its notes (ETLRunResult.note,
-- R36's time checks and corrections, untimed or undecodable values). Before
-- this, only a failed stage kept its stderr (error_message), so a stage that
-- succeeded with gaps looked clean. error_message stays reserved for
-- failures: the app and the report read a value there as one.
--
-- NULL = the stage printed nothing, or hasn't finished. It never changes
-- run_completeness: a run whose stages succeeded with warnings is complete.
-- Single statement: it is both this migration's start and finish marker in
-- migrate.py.

ALTER TABLE pipeline_stage_status ADD COLUMN warnings TEXT;
