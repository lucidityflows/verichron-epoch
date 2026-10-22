import { shell } from 'electron';
import fs from 'fs/promises';
import type { Pool } from 'pg';
import { getRunReportLocation } from '@verichron/etl-db-reader';
import { handleIpc } from './typedIpc';

/** A run's report is in its report folder (see getRunReportLocation). */
async function reportPathFor(dbPool: Pool, runId: string): Promise<string | undefined> {
  const reportPath = await getRunReportLocation(dbPool, runId);
  return reportPath ?? undefined;
}

export function registerReportHandlers(dbPool: Pool) {
  handleIpc('epoch:getReport', async (_event, runId: string) => {
    const reportPath = await reportPathFor(dbPool, runId);
    if (!reportPath) {
      return { status: 'no-report-path' as const };
    }
    try {
      const content = await fs.readFile(reportPath, 'utf-8');
      return { status: 'ok' as const, content, path: reportPath };
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return { status: 'not-found' as const, path: reportPath };
      }
      console.error('Report read error:', err);
      throw err;
    }
  });

  handleIpc('epoch:openReport', async (_event, runId: string) => {
    const reportPath = await reportPathFor(dbPool, runId);
    if (!reportPath) return false;
    const result = await shell.openPath(reportPath);
    return result === '';
  });
}
