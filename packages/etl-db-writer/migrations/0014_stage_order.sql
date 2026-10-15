-- 0014_stage_order.sql  (EPOCH-414)
--
-- A stage's order has one owner, its stage.json (R2). The orchestrator now
-- records it on each stage row, and readers order a run's stages by it,
-- instead of a hard-coded list in the reader that had drifted from the real
-- stages.
--
-- Rows created before this migration have no order, and it is never guessed
-- or backfilled: development data is disposable (decided 2026-10-15, project
-- owner). A database with runs is refused; recreate it and import again.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pipeline_stage_status) THEN
        RAISE EXCEPTION 'pipeline_stage_status holds runs from before EPOCH-414, which have no stage order; '
            'recreate the development database and import again';
    END IF;
END
$$;

-- An integer, as stage.json's `order` is (stage-manifest.schema.json).
ALTER TABLE pipeline_stage_status
    ADD COLUMN stage_order INTEGER NOT NULL;
