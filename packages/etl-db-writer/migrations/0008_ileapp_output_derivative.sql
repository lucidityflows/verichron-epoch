-- 0008_ileapp_output_derivative.sql  (EPOCH-416)
--
-- iLEAPP's output becomes a derivative of its own, kind 'ileapp_output', with
-- the decrypt it was made from as its parent. The processor produces it at
-- <workspace>/ileapp/<label>/ and marks it complete with .ileapp_ok; the
-- orchestrator registers it from that marker, and the iLEAPP bridge reads it.
-- Facts the bridge writes are filed under this derivative, not the decrypt,
-- because they are read from iLEAPP's output (R7).
--
-- One statement, so the old constraint is never dropped without the new one.
-- The constraint is named so migrate.py can tell this migration has run.

ALTER TABLE evidence_derivatives
    DROP CONSTRAINT evidence_derivatives_kind_check,
    ADD CONSTRAINT evidence_derivatives_kind_known
        CHECK (kind IN ('decrypted', 'mvt_results', 'ileapp_output'));
