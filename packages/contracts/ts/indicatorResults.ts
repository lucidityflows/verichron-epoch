import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { packageRoot } from './contractVersion.js';

/** How indicator results are presented (EPOCH-493). */
export interface IndicatorResultsConfig {
  /** A set is marked stale when its newest indicator was older than this many days when checked. */
  staleAfterDays: number;
  /** Stated with every result. */
  limit: string;
  /** Stated wherever nothing was checked. */
  nothingChecked: string;
}

/**
 * Read from indicator_results.json, the one file the report (Python) reads
 * too, so the app and the report can't disagree.
 */
export function indicatorResultsConfig(): IndicatorResultsConfig {
  const file = path.join(packageRoot(), 'indicator_results.json');
  const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const days = config.stale_after_days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1) {
    throw new Error(`indicator_results.json: stale_after_days must be a positive integer, not ${String(days)}`);
  }
  for (const key of ['limit', 'nothing_checked']) {
    const value = config[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`indicator_results.json: ${key} must be a sentence`);
    }
  }
  return { staleAfterDays: days, limit: config.limit as string, nothingChecked: config.nothing_checked as string };
}
