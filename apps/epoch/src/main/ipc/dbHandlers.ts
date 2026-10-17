import { ipcMain } from 'electron';
import { Pool } from 'pg';
import {
  getPipelineRuns,
  getRunEvidence,
  getStageStatus,
  getForensicRecords,
  getIndicatorChecks,
  getStageFailures,
  getStillFailing,
  type ForensicRecordPage,
  type ItemFailurePage,
  type ForensicRecordQuery,
} from '@verichron/etl-db-reader';
import { indicatorResultsConfig } from '@verichron/contracts';
import type { IndicatorResults } from '../../shared/types/window';

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
