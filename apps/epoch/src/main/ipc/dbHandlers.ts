import { ipcMain } from 'electron';
import { Pool } from 'pg';
import {
  getPipelineRuns,
  getRunEvidence,
  getStageStatus,
  getForensicRecords,
  getRecordFacets,
  getEvidenceCompleteness,
  getRecordDetail,
  getEntityKinds,
  getEntityValues,
  getEntityCoverage,
  getIndicatorChecks,
  getStageFailures,
  getStillFailing,
  getInterruptedStages,
  getTimelineOverview,
  getTimelineDensity,
  getTimelineRecords,
  getRecordContextWindow,
  type ForensicRecordPage,
  type ItemFailurePage,
  type ForensicRecordQuery,
  type EntityValueQuery,
} from '@verichron/etl-db-reader';
import { entityKinds, entityShapeHints, indicatorResultsConfig } from '@verichron/contracts';
import type { EntityOverview, IndicatorResults } from '../../shared/types/window';

/** What a run with no registered evidence (pre-EPOCH-404) shows: nothing,
 * stated as such, rather than another evidence item's facts. */
const NO_RECORDS: ForensicRecordPage = { rows: [], total: 0, nextCursor: null };
const NO_FAILURES: ItemFailurePage = { rows: [], total: 0 };

export function registerDbHandlers(dbPool: Pool) {
  ipcMain.handle('epoch:getPipelineRuns', async () => {
    try {
      return await getPipelineRuns(dbPool);
    } catch (err) {
      console.error('DB error:', err);
      throw err;
    }
  });

  ipcMain.handle('epoch:getStageStatus', async (_event, runId: string) => {
    try {
      return await getStageStatus(dbPool, runId);
    } catch (err) {
      console.error('DB error:', err);
      throw err;
    }
  });

  // The items one stage of a run could not ingest (EPOCH-432).
  ipcMain.handle('epoch:getStageFailures', async (_event, runId: string, stageName: string) => {
    try {
      return await getStageFailures(dbPool, runId, stageName);
    } catch (err) {
      console.error('DB error:', err);
      throw err;
    }
  });

  // The selected run's evidence's items that are still failing, whichever run
  // failed them (EPOCH-432, R7).
  ipcMain.handle('epoch:getStillFailing', async (_event, runId: string) => {
    try {
      const evidenceId = await getRunEvidence(dbPool, runId);
      return evidenceId ? await getStillFailing(dbPool, evidenceId) : NO_FAILURES;
    } catch (err) {
      console.error('DB error:', err);
      throw err;
    }
  });

  // The selected run's evidence's fact-writing stages whose latest attempt was
  // interrupted, so recorded none of the items they failed (EPOCH-561, R7).
  ipcMain.handle('epoch:getInterruptedStages', async (_event, runId: string) => {
    try {
      const evidenceId = await getRunEvidence(dbPool, runId);
      return evidenceId ? await getInterruptedStages(dbPool, evidenceId) : [];
    } catch (err) {
      console.error('DB error:', err);
      throw err;
    }
  });

  // The renderer still selects a run; facts belong to the run's evidence (R7),
  // so every fact read resolves run -> evidence first. Any run over the same
  // evidence therefore shows the same records.
  ipcMain.handle('epoch:getForensicRecords', async (_event, runId: string, query?: ForensicRecordQuery) => {
    try {
      const evidenceId = await getRunEvidence(dbPool, runId);
      if (!evidenceId) return NO_RECORDS;
      return await getForensicRecords(dbPool, evidenceId, query ?? {});
    } catch (err) {
      console.error('DB error:', err);
      throw err;
    }
  });

  // Forensic Records' counts, what was examined, and one opened record (EPOCH-411, EPOCH-556),
  // for the selected run's evidence. A run with no registered evidence has none.
  ipcMain.handle('epoch:getRecordFacets', async (_event, runId: string, query?: ForensicRecordQuery) => {
    const evidenceId = await getRunEvidence(dbPool, runId);
    return evidenceId ? getRecordFacets(dbPool, evidenceId, query ?? {}) : null;
  });

  ipcMain.handle('epoch:getEvidenceCompleteness', async (_event, runId: string) => {
    const evidenceId = await getRunEvidence(dbPool, runId);
    return evidenceId ? getEvidenceCompleteness(dbPool, evidenceId) : null;
  });

  // The Timeline (EPOCH-580): the selected run's evidence placed in time, counted by the database.
  // Its arguments come from the renderer, so they are checked before any query.
  const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const timeline = async <T>(runId: unknown, read: (evidenceId: string) => Promise<T>): Promise<T | null> => {
    if (!isText(runId)) throw new Error('a timeline read needs a run id');
    try {
      const evidenceId = await getRunEvidence(dbPool, runId);
      return evidenceId ? await read(evidenceId) : null;
    } catch (err) {
      console.error('DB error:', err);
      throw err;
    }
  };

  ipcMain.handle('epoch:getTimelineOverview', async (_event, runId: unknown) =>
    timeline(runId, (evidenceId) => getTimelineOverview(dbPool, evidenceId))
  );

  ipcMain.handle('epoch:getTimelineDensity', async (_event, runId: unknown, boundaries: unknown) => {
    if (!Array.isArray(boundaries) || !boundaries.every(isText)) {
      throw new Error('a timeline density needs its bucket boundaries as a list of times');
    }
    return timeline(runId, (evidenceId) => getTimelineDensity(dbPool, evidenceId, boundaries));
  });

  ipcMain.handle('epoch:getTimelineRecords', async (_event, runId: unknown, from: unknown, before: unknown) => {
    if (!isText(from) || !isText(before)) throw new Error("a timeline's records need a range: from and before");
    return timeline(runId, (evidenceId) => getTimelineRecords(dbPool, evidenceId, from, before));
  });

  // A record's correlated-context window (EPOCH-522), from the database's own function (R27).
  ipcMain.handle('epoch:getRecordContextWindow', async (_event, runId: unknown, recordId: unknown) => {
    if (!isText(recordId) || !/^\d+$/.test(recordId)) throw new Error('a context window needs a record id');
    return timeline(runId, (evidenceId) => getRecordContextWindow(dbPool, evidenceId, recordId));
  });

  ipcMain.handle('epoch:getRecordDetail', async (_event, runId: string, recordId: string) => {
    const evidenceId = await getRunEvidence(dbPool, runId);
    return evidenceId ? getRecordDetail(dbPool, evidenceId, recordId) : null;
  });

  // What the evidence's records mention (EPOCH-581): each kind with its title
  // from entity_rules.json, and what the rules didn't read.
  ipcMain.handle('epoch:getEntityOverview', async (_event, runId: string): Promise<EntityOverview | null> => {
    const evidenceId = await getRunEvidence(dbPool, runId);
    if (!evidenceId) return null;
    const titles = new Map(entityKinds().map((k) => [k.kind, k.title]));
    const [kinds, coverage] = await Promise.all([
      getEntityKinds(dbPool, evidenceId),
      getEntityCoverage(dbPool, evidenceId),
    ]);
    return {
      kinds: kinds.map((k) => ({ ...k, title: titles.get(k.kind) ?? k.kind })),
      coverage,
      shapeHints: entityShapeHints(),
    };
  });

  ipcMain.handle('epoch:getEntityValues', async (_event, runId: string, kind: string, query?: EntityValueQuery) => {
    const evidenceId = await getRunEvidence(dbPool, runId);
    return evidenceId ? getEntityValues(dbPool, evidenceId, kind, query ?? {}) : { rows: [], total: 0 };
  });

  // Every check of the selected run's evidence (EPOCH-493), with the stale
  // threshold the report uses too, read here because the renderer can't.
  ipcMain.handle('epoch:getIndicatorResults', async (_event, runId: string): Promise<IndicatorResults> => {
    try {
      const evidenceId = await getRunEvidence(dbPool, runId);
      const checks = evidenceId ? await getIndicatorChecks(dbPool, evidenceId) : [];
      return { evidenceRegistered: !!evidenceId, checks, ...indicatorResultsConfig() };
    } catch (err) {
      console.error('DB error:', err);
      throw err;
    }
  });
}
