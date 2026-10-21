-- 0024_record_context.sql  (EPOCH-522)
--
-- Correlated context: the evidence's other records within a window of time
-- around one record (an indicator match's fact, or any record the examiner
-- opens). R27: a query two languages must agree on lives in the database.
-- The report (Python) and the app (TypeScript) both call these functions,
-- and neither declares a window: the default is correlation_window(), here
-- and nowhere else (a test greps the code for any other).
--
-- The window is centred on the record's time and widened to whole seconds:
-- from the start of the second `time - window` falls in, through the end of
-- the second `time + window` falls in. It is returned as [window_from,
-- window_before), the end exclusive at the next whole second, which is how
-- Forensic Records' time filter reads a range, so a filter shows exactly the
-- window in force, to the second. A record with no time has no window (R11):
-- the window function returns its row with nulls, and the context functions
-- return nothing.
--
-- The context leaves out the record itself and the tool judgements that cite
-- it (its own indicator matches), which share its time and say nothing more
-- about what happened around it.
--
-- Plain SQL, STABLE, read-only: shared reads, never application behaviour.

-- The default window either side of a record: ±15 minutes (the owner, 2026-10-21).
CREATE FUNCTION correlation_window() RETURNS INTERVAL
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT INTERVAL '15 minutes'
$$;

-- One current record's window. No row when the record isn't a current record
-- of this evidence; nulls when it has no time.
CREATE FUNCTION record_context_window(
    p_evidence UUID,
    p_record BIGINT,
    p_window INTERVAL DEFAULT correlation_window()
) RETURNS TABLE (record_time TIMESTAMPTZ, window_from TIMESTAMPTZ, window_before TIMESTAMPTZ, half_width INTERVAL)
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT r.event_time,
           date_trunc('second', r.event_time - p_window),
           date_trunc('second', r.event_time + p_window) + INTERVAL '1 second',
           p_window
      FROM current_forensic_records r
     WHERE r.evidence_id = p_evidence AND r.id = p_record
$$;

-- The records in a record's window, nearest first (then by time and id), at
-- most p_limit of them when it is given. The bounds are scalar subqueries, so
-- they are computed once and the time index's range serves the scan
-- (idx_forensic_evidence_time, evidence then time); a join to the window let
-- the planner scan the whole evidence and filter afterwards.
CREATE FUNCTION record_context(
    p_evidence UUID,
    p_record BIGINT,
    p_window INTERVAL DEFAULT correlation_window(),
    p_limit INTEGER DEFAULT NULL
) RETURNS TABLE (
    id BIGINT,
    event_time TIMESTAMPTZ,
    offset_seconds DOUBLE PRECISION,
    source_type TEXT,
    category TEXT,
    artifact TEXT,
    fields JSONB
)
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT r.id, r.event_time, extract(epoch FROM r.event_time - c.record_time)::DOUBLE PRECISION,
           r.source_type, r.category, r.source_artifact, r.fields
      FROM current_forensic_records r,
           (SELECT w.record_time FROM record_context_window(p_evidence, p_record, p_window) w) c
     WHERE r.evidence_id = p_evidence
       AND r.event_time >= (SELECT w.window_from FROM record_context_window(p_evidence, p_record, p_window) w)
       AND r.event_time < (SELECT w.window_before FROM record_context_window(p_evidence, p_record, p_window) w)
       AND r.id <> p_record
       AND NOT (r.source_type = 'indicator_match' AND r.fields -> 'fact' ->> 'record_id' = p_record::TEXT)
     ORDER BY abs(extract(epoch FROM r.event_time - c.record_time)), r.event_time, r.id
     LIMIT p_limit
$$;

-- How many records the window holds, by source and artifact: the true counts
-- (R25), whatever the listing's limit.
CREATE FUNCTION record_context_counts(
    p_evidence UUID,
    p_record BIGINT,
    p_window INTERVAL DEFAULT correlation_window()
) RETURNS TABLE (source_type TEXT, category TEXT, artifact TEXT, records BIGINT)
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT c.source_type, c.category, c.artifact, count(*)
      FROM record_context(p_evidence, p_record, p_window) c
     GROUP BY c.source_type, c.category, c.artifact
     ORDER BY count(*) DESC, c.source_type, c.category NULLS LAST, c.artifact NULLS LAST
$$;

GRANT EXECUTE ON FUNCTION public.correlation_window() TO verichron_epoch_runtime;
GRANT EXECUTE ON FUNCTION public.record_context_window(UUID, BIGINT, INTERVAL) TO verichron_epoch_runtime;
GRANT EXECUTE ON FUNCTION public.record_context(UUID, BIGINT, INTERVAL, INTEGER) TO verichron_epoch_runtime;
GRANT EXECUTE ON FUNCTION public.record_context_counts(UUID, BIGINT, INTERVAL) TO verichron_epoch_runtime;
