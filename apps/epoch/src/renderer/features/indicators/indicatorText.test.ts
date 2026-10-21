/**
 * EPOCH-493: the Indicator Matches view states the set, its age when checked,
 * what wasn't checked and why, and never a verdict word.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { IndicatorCheckRow } from '@verichron/etl-db-reader';

import {
  checkState,
  checkTiles,
  comparedTypes,
  groupChecks,
  notCheckedLines,
  resultLine,
  setLine,
  sourceLine,
  staleLine,
  stateLabel,
} from './indicatorText';

const NOTHING = 'No match is reported because nothing was checked.';
const VERDICTS = /\b(compromised|infected|clean)\b/i;

const base: IndicatorCheckRow = {
  run_id: 'run-1',
  status: 'succeeded',
  error_message: null,
  finished_at: '2026-10-15T14:30:00.000Z',
  indicator_set_id: 'set-1',
  set_name: 'mvt-indicators index b22ddf05e1a3',
  set_hash: 'e3fb2081f3e1' + '0'.repeat(52),
  set_registered_at: '2026-10-15T12:00:00.000Z',
  newest_indicator: '2026-10-09T00:00:00.000Z',
  ingest_id: 'unit-1',
  matches: 0,
  summary: {
    set: { set_id: 'set-1', set_hash: 'e3fb', name: 'x' },
    matches: 0,
    types: {
      ip: { indicators: 73, status: 'no_source', reason: 'an iOS backup keeps no network connection log.' },
      bundle_id: { indicators: 684, status: 'no_facts', reason: 'none of its sources held a value in this case' },
      domain: { indicators: 6692, status: 'checked', values_checked: 7545, matches: 0, sources: [] },
    },
    not_loaded: { indicator_type: 501 },
    coverage: { unread_fields: 2251, unread_sources: 107, shaped_fields: 31, records_not_read_for_entities: 4 },
    ileapp_plugin_errors: [{ module: 'ZaloChats', artifact: 'zalo_messages' }],
  },
  sources: [
    {
      source_repository: 'mvt-project/mvt-indicators',
      source_commit: 'b22ddf05e1a31e7732b8895676987c5c3482ef65',
      licence: 'MIT',
      redistributable: true,
      files: '14',
      downloaded_on: '2026-10-15',
    },
  ],
  match_rows: [],
};

describe('indicator wording', () => {
  it('states the set, when it was fetched, and its newest indicator age when checked', () => {
    assert.equal(
      setLine(base, 'UTC'),
      'Set: mvt-indicators index b22ddf05e1a3, fetched 2026-10-15 (e3fb2081f3e1). ' +
        'Newest indicator 2026-10-09 UTC: 6 day(s) old when checked.'
    );
    assert.equal(staleLine(base, 90, 'UTC'), null);
    const old = { ...base, newest_indicator: '2026-05-01T00:00:00.000Z' };
    assert.equal(
      staleLine(old, 90, 'UTC'),
      'Older than 90 days when checked: indicators published since are not in it.'
    );
  });

  it('says no match, or how many, and that nothing was checked when it was skipped or failed', () => {
    assert.equal(resultLine(base, NOTHING), 'No match against this set.');
    assert.equal(resultLine({ ...base, matches: 1330 }, NOTHING), '1,330 match(es) against this set.');
    const skipped = {
      ...base,
      status: 'skipped' as const,
      error_message: 'No indicator set is registered, so indicators were not checked.',
      summary: null,
      matches: null,
    };
    assert.equal(
      resultLine(skipped, NOTHING),
      'No indicator set is registered, so indicators were not checked. ' + NOTHING
    );
    const failed = { ...base, status: 'failed' as const, error_message: 'the database went away', summary: null };
    assert.equal(
      resultLine(failed, NOTHING),
      'The check did not complete (failed): the database went away. ' + NOTHING
    );
  });

  it('keeps what a check made before entities did not read', () => {
    const older = {
      ...base,
      summary: { ...base.summary!, coverage: undefined, not_read: { free_text: 'URLs in messages.' } },
    };
    assert.ok(notCheckedLines(older).includes('Not read: URLs in messages.'));
    assert.ok(!notCheckedLines(older).some((line) => line.startsWith('Not compared')));
  });

  it('lists every type not checked, with why, in a fixed order', () => {
    assert.deepEqual(notCheckedLines(base), [
      'IP address (73): no source in any backup. an iOS backup keeps no network connection log.',
      'Bundle ID (684): no facts in this case: none of its sources held a value in this case.',
      'Not loaded from the set: 501 indicators. Of types no iOS backup holds (app certificates, Android properties, configuration profiles): 501.',
      'Not compared: 2,251 field(s) in 107 source(s) held values that no entity rule reads (31 shaped like an entity); Forensic Records lists them.',
      "Not read for entities: 4 record(s), so they weren't compared. Analyze again to read them.",
      "iLEAPP plugin errored: zalo_messages (ZaloChats); its records weren't checked.",
    ]);
  });

  it('marks a file with an unknown licence as not redistributable', () => {
    assert.equal(sourceLine(base.sources[0]), 'mvt-project/mvt-indicators @ b22ddf05e1a3, MIT: 14 file(s)');
    assert.equal(
      sourceLine({
        ...base.sources[0],
        source_repository: null,
        source_commit: null,
        licence: 'unknown',
        redistributable: false,
        files: '1',
      }),
      'local files, licence unknown: loaded locally; not redistributable: 1 file(s)'
    );
  });

  it("dates the set in the examiner's zone and counts the days shown there, as the report does (EPOCH-560)", () => {
    // 2026-10-09 00:00 UTC is the evening of the 8th in Chicago, 7 days before the check on the 15th there.
    assert.equal(
      setLine(base, 'America/Chicago'),
      'Set: mvt-indicators index b22ddf05e1a3, fetched 2026-10-15 (e3fb2081f3e1). ' +
        'Newest indicator 2026-10-08 CDT, UTC−05:00: 7 day(s) old when checked.'
    );
  });

  it('names where a check stands, so nothing compared never reads like nothing found (board 8)', () => {
    const skipped = { ...base, status: 'skipped' as const, summary: null, matches: null };
    assert.deepEqual(
      [base, { ...base, matches: 1 }, { ...base, matches: 3 }, skipped, { ...base, status: 'failed' as const }].map(
        (c) => [checkState(c), stateLabel(c)]
      ),
      [
        ['no-match', 'Checked, no matches'],
        ['matches', '1 match'],
        ['matches', '3 matches'],
        ['not-checked', 'Not checked'],
        ['failed', 'Check failed'],
      ]
    );
  });

  it('counts the indicators loaded, those of types compared, the facts compared and the matches', () => {
    assert.deepEqual(checkTiles(base), { loaded: 7449, testable: 7376, compared: 7545, matches: 0 });
    assert.deepEqual(comparedTypes(base), [['domain', 7545]]);
    assert.equal(checkTiles({ ...base, summary: null }), null);
  });

  it('lists checks of one unit, or of one reason for comparing nothing, together and in order', () => {
    const run = (run_id: string, ingest_id: string | null, error_message: string | null = null) => ({
      ...base,
      run_id,
      ingest_id,
      error_message,
    });
    const groups = groupChecks([
      run('a', 'u1'),
      run('b', null, 'No indicator set is registered.'),
      run('c', 'u1'),
      run('d', 'u2'),
      run('e', null, 'No indicator set is registered.'),
      run('f', null, 'another reason'),
    ]);
    assert.deepEqual(
      groups.map((g) => g.map((c) => c.run_id)),
      [['a', 'c'], ['b', 'e'], ['d'], ['f']]
    );
  });

  it('uses no verdict word', () => {
    const texts = [
      setLine(base, 'UTC'),
      staleLine({ ...base, newest_indicator: '2025-01-01T00:00:00.000Z' }, 90, 'UTC') ?? '',
      resultLine(base, NOTHING),
      resultLine({ ...base, matches: 2 }, NOTHING),
      stateLabel(base),
      stateLabel({ ...base, matches: 2 }),
      ...notCheckedLines(base),
      ...base.sources.map(sourceLine),
    ];
    for (const text of texts) assert.doesNotMatch(text, VERDICTS);
  });
});
