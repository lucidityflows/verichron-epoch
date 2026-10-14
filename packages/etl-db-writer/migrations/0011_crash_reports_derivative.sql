-- 0011_crash_reports_derivative.sql  (EPOCH-447)
--
-- An iOS backup holds none of the device's crash logs (verified on a real
-- backup, EPOCH-447). They are copied from the device separately (EPOCH-514)
-- and become a derivative of their own, 'crash_reports', which the crash
-- stage reads.
--
-- One ALTER, so the old constraint is never dropped without the new one. The
-- new constraint is named so migrate.py can tell this migration has run.

ALTER TABLE evidence_derivatives
    DROP CONSTRAINT evidence_derivatives_kind_current,
    ADD CONSTRAINT evidence_derivatives_kind_with_crash_reports
        CHECK (kind IN ('decrypted', 'ileapp_output', 'crash_reports'));
