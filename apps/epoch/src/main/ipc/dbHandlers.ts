import { ipcMain } from 'electron';
import { Pool } from 'pg';
import {
  getPipelineRuns,
  getRunEvidence,
  getStageStatus,
  getForensicRecords,
  getIndicatorChecks,
  type ForensicRecordPage,
  type ForensicRecordQuery,
} from '@verichron/etl-db-reader';
import { indicatorResultsConfig } from '@verichron/contracts';
import type { IndicatorResults } from '../../shared/types/window';

/** What a run with no registered evidence (pre-EPOCH-404) shows: nothing,
 * stated as such, rather than another evidence item's facts. */
const NO_RECORDS: ForensicRecordPage = { rows: [], total: 0, nextCursor: null };

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
