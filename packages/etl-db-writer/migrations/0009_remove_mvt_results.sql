-- 0009_remove_mvt_results.sql  (EPOCH-489)
--
-- mvt-ios is removed from the project, so the 'mvt_results' derivative kind
-- (mvt's check-backup output, added in 0003) goes with it. Derivatives are
-- now the decrypt and iLEAPP's output.
--
-- A database that still holds mvt results is refused with a message rather
-- than migrated: development data is disposable, and those rows (and the
-- mvt_ioc_detection / timestamp_anomaly facts filed under them) have no
-- producer any more. Recreate the database volume to continue.
--
-- One ALTER, so the old constraint is never dropped without the new one. The
-- new constraint is named so migrate.py can tell this migration has run.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM evidence_derivatives WHERE kind = 'mvt_results') THEN
        RAISE EXCEPTION 'evidence_derivatives holds mvt_results rows, which EPOCH-489 removes; recreate the development database';
    END IF;
END
$$;

ALTER TABLE evidence_derivatives
    DROP CONSTRAINT evidence_derivatives_kind_known,
    ADD CONSTRAINT evidence_derivatives_kind_current
        CHECK (kind IN ('decrypted', 'ileapp_output'));
