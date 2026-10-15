/**
 * The words the Indicator Matches view uses (EPOCH-493), kept apart from the
 * layout so they can be tested. They follow the report's approved section
 * (apps/reporting/generate_report.py, render_indicator_section) line for
 * line; the two fixed sentences come from the shared indicator_results.json.
 * No verdict word is used anywhere.
 */

import type { IndicatorCheckRow, IndicatorSetSourceRow } from '@verichron/etl-db-reader';

export const TYPE_LABELS: Record<string, string> = {
  domain: 'Domain',
  url: 'URL',
  ip: 'IP address',
  process_name: 'Process name',
  bundle_id: 'Bundle ID',
  email: 'Email address',
  file_hash: 'File hash (SHA-256)',
  file_path: 'File path',
  file_name: 'File name',
};

/** Why the loader didn't load an indicator, in words (as the report says it). */
const NOT_LOADED: Record<string, string> = {
  indicator_type: 'of types no iOS backup holds (app certificates, Android properties, configuration profiles)',
  operator: 'using operators other than = and IN',
  comparison_and: 'combining comparisons with AND',
  observation_and: 'combining observations with AND',
  observation_or: 'combining observations with OR',
  followedby: 'using FOLLOWEDBY',
  qualifier: 'using time qualifiers',
  object_path: 'on object paths no backup supplies',
  pattern_type: "whose patterns aren't STIX",
  value: "whose values couldn't be normalized",
  revoked: 'revoked by their publisher',
};

const count = (n: number | string) => Number(n).toLocaleString('en-US');
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** Types in one fixed order (the database doesn't keep a JSON object's key order). */
export function inOrder<T>(types: Record<string, T>): [string, T][] {
  const order = Object.keys(TYPE_LABELS);
  const rank = (t: string) => (order.includes(t) ? order.indexOf(t) : order.length);
  return Object.entries(types).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

export const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;

/** Whole days from the set's newest indicator to the check, by UTC date. */
export function ageWhenChecked(check: IndicatorCheckRow): number | null {
  if (!check.newest_indicator || !check.finished_at) return null;
  const toDay = (iso: string) => Date.parse(day(iso));
  return Math.round((toDay(check.finished_at) - toDay(check.newest_indicator)) / 86_400_000);
}

/** The set, when it was fetched (or registered), and its newest indicator's age when checked. */
export function setLine(check: IndicatorCheckRow): string {
  const downloaded = check.sources.map((s) => s.downloaded_on).filter((d): d is string => !!d);
  const when = downloaded.length
    ? `fetched ${downloaded.sort().at(-1)!.slice(0, 10)}`
    : `registered ${check.set_registered_at ? day(check.set_registered_at) : 'on an unknown date'}`;
  const line = `Set: ${check.set_name}, ${when} (${(check.set_hash ?? '').slice(0, 12)}).`;
  const age = ageWhenChecked(check);
  if (age === null || !check.newest_indicator) return `${line} It holds no indicator this check could load.`;
  return `${line} Newest indicator ${day(check.newest_indicator)}: ${age} day(s) old when checked.`;
}

export function staleLine(check: IndicatorCheckRow, staleAfterDays: number): string | null {
  const age = ageWhenChecked(check);
  return age !== null && age > staleAfterDays
    ? `Older than ${staleAfterDays} days when checked: indicators published since are not in it.`
    : null;
}

/** The check's outcome in one sentence. */
export function resultLine(check: IndicatorCheckRow, nothingChecked: string): string {
  if (check.status === 'skipped')
    return `${check.error_message ?? 'The orchestrator recorded no reason.'} ${nothingChecked}`;
  if (check.status !== 'succeeded') {
    const detail = check.error_message ? `: ${check.error_message.replace(/\.$/, '')}.` : '.';
    return `The check did not complete (${check.status})${detail} ${nothingChecked}`;
  }
  if (check.summary === null || check.matches === null) {
    return `The check finished but its result is not recorded. ${nothingChecked}`;
  }
  return check.matches ? `${count(check.matches)} match(es) against this set.` : 'No match against this set.';
}

/** Everything the check could not check, each with why. */
export function notCheckedLines(check: IndicatorCheckRow): string[] {
  const summary = check.summary;
  if (!summary) return [];
  const lines: string[] = [];
  for (const [t, entry] of inOrder(summary.types)) {
    if (entry.status === 'no_source') {
      lines.push(`${typeLabel(t)} (${count(entry.indicators)}): no source in any backup. ${entry.reason ?? ''}`.trim());
    } else if (entry.status === 'no_facts') {
      lines.push(`${typeLabel(t)} (${count(entry.indicators)}): no facts in this case: ${entry.reason ?? ''}.`);
    }
  }
  const notLoaded = Object.entries(summary.not_loaded ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (notLoaded.length) {
    const total = notLoaded.reduce((sum, [, n]) => sum + n, 0);
    const detail = notLoaded.map(([reason, n]) => `${NOT_LOADED[reason] ?? reason}: ${count(n)}`).join('; ');
    lines.push(`Not loaded from the set: ${count(total)} indicators. ${detail[0].toUpperCase()}${detail.slice(1)}.`);
  }
  for (const reason of Object.values(summary.not_read ?? {})) lines.push(`Not read: ${reason}`);
  for (const e of summary.ileapp_plugin_errors ?? []) {
    lines.push(`iLEAPP plugin errored: ${e.artifact} (${e.module}); its records weren't checked.`);
  }
  return lines;
}

/** A set's sources and licences, generated from its manifest. */
export function sourceLine(s: IndicatorSetSourceRow): string {
  const where = s.source_repository
    ? `${s.source_repository} @ ${(s.source_commit ?? '').slice(0, 12)}`
    : 'local files';
  const licence =
    s.licence === 'unknown'
      ? 'licence unknown: loaded locally; not redistributable'
      : `${s.licence}${s.redistributable ? '' : '; not redistributable'}`;
  return `${where}, ${licence}: ${count(s.files)} file(s)`;
}
