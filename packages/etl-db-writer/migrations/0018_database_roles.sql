-- 0018_database_roles.sql  (EPOCH-562)
--
-- The immutability triggers (0015, 0016) and the audited purge are a security
-- boundary only if the identity the app runs as cannot undo them. An owner, and
-- above all a superuser, can disable a trigger, change privileges, or TRUNCATE
-- (which fires no row trigger). So ownership and runtime access are separate
-- roles, neither of which can log in:
--
--   verichron_epoch_schema_owner  owns every table, view, sequence and trigger
--                                 function. Nothing logs in as it.
--   verichron_epoch_runtime       what the app, the orchestrator, the stages and
--                                 the indicator registry may do: read
--                                 everything, write only what the writers
--                                 write, and purge only through
--                                 purge_evidence. No TRUNCATE, no ownership.
--   verichron_epoch_purge_owner   (0015) owns purge_evidence, unchanged.
--
-- The login the app connects as is not created here: a migration holds no
-- password (R28). provision_roles.py creates it from DB_APP_USER /
-- DB_APP_PASSWORD and makes it a member of verichron_epoch_runtime, and of
-- nothing else. Migrations run as the administrative identity (a superuser),
-- as before.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verichron_epoch_schema_owner') THEN
        EXECUTE 'CREATE ROLE verichron_epoch_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verichron_epoch_runtime') THEN
        EXECUTE 'CREATE ROLE verichron_epoch_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT';
    END IF;
END
$$;

ALTER ROLE verichron_epoch_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE verichron_epoch_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

-- Gives every table, view, sequence and function in public to the schema
-- owner, except what an extension owns and purge_evidence (the purge owner's).
-- migrate.py calls it after every run, so an object a later migration creates
-- is adopted too; that migration still grants the runtime what it needs, and
-- scripts/test_db_roles.py checks both for every object.
CREATE OR REPLACE PROCEDURE public.verichron_epoch_adopt()
LANGUAGE plpgsql AS $$
DECLARE
    obj RECORD;
BEGIN
    FOR obj IN
        SELECT c.oid, c.relkind, format('%I.%I', n.nspname, c.relname) AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
          AND pg_get_userbyid(c.relowner) <> 'verichron_epoch_schema_owner'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
          -- A sequence a column owns moves with its table.
          AND NOT (c.relkind = 'S' AND EXISTS (
              SELECT 1 FROM pg_depend d
              WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')))
        ORDER BY c.relkind DESC
    LOOP
        EXECUTE format(
            CASE obj.relkind
                WHEN 'v' THEN 'ALTER VIEW %s OWNER TO verichron_epoch_schema_owner'
                WHEN 'm' THEN 'ALTER MATERIALIZED VIEW %s OWNER TO verichron_epoch_schema_owner'
                WHEN 'S' THEN 'ALTER SEQUENCE %s OWNER TO verichron_epoch_schema_owner'
                ELSE 'ALTER TABLE %s OWNER TO verichron_epoch_schema_owner'
            END,
            obj.name
        );
    END LOOP;

    FOR obj IN
        SELECT p.oid::regprocedure AS signature, p.prokind
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname <> 'purge_evidence'
          AND pg_get_userbyid(p.proowner) <> 'verichron_epoch_schema_owner'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    LOOP
        EXECUTE format(
            CASE obj.prokind WHEN 'p' THEN 'ALTER PROCEDURE %s OWNER TO verichron_epoch_schema_owner'
                             ELSE 'ALTER FUNCTION %s OWNER TO verichron_epoch_schema_owner' END,
            obj.signature
        );
    END LOOP;
END
$$;

-- Only the administrative identity runs the adoption.
REVOKE ALL ON PROCEDURE public.verichron_epoch_adopt() FROM PUBLIC;

CALL public.verichron_epoch_adopt();

-- The runtime reads everything (the reader's views run as their owner).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO verichron_epoch_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO verichron_epoch_runtime;

-- What the writers write, and nothing more. The immutability triggers still
-- refuse any change to completed facts, run links, failures and custody events.
--   registration (orchestrator): devices and locations upsert, derivatives
--   upsert their path, evidence items insert once, custody events append.
GRANT INSERT, UPDATE ON public.devices, public.evidence_locations, public.evidence_derivatives
    TO verichron_epoch_runtime;
GRANT INSERT ON public.evidence_items, public.evidence_events TO verichron_epoch_runtime;
--   runs and stages (orchestrator, and the app's close-out, EPOCH-435).
GRANT INSERT, UPDATE ON public.pipeline_runs, public.pipeline_stage_status TO verichron_epoch_runtime;
--   facts (db_writer.py): a unit is upserted and completed; reclaiming an
--   abandoned unit deletes its orphaned records; run links and failures append.
GRANT INSERT, UPDATE ON public.ingested_files TO verichron_epoch_runtime;
GRANT INSERT, DELETE ON public.forensic_records TO verichron_epoch_runtime;
GRANT INSERT ON public.ingest_run_links, public.stage_item_failures TO verichron_epoch_runtime;
--   the indicator registry (EPOCH-490), append-only.
GRANT INSERT ON public.indicator_file_contents, public.indicator_sets, public.indicator_set_files,
    public.indicators TO verichron_epoch_runtime;

-- Purge only through the audited function. Granted last, so migrate.py can
-- tell this migration finished (roles are cluster-wide; this grant is not).
GRANT EXECUTE ON FUNCTION public.purge_evidence(UUID, TEXT) TO verichron_epoch_runtime;
