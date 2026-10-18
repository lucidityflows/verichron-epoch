/**
 * EPOCH-493: the Indicator Matches view states the set, its age when checked,
 * what wasn't checked and why, and never a verdict word.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { IndicatorCheckRow } from '@verichron/etl-db-reader';

import { notCheckedLines, resultLine, setLine, sourceLine, staleLine } from './indicatorText';

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
    not_read: { free_text: 'URLs inside message text are not read.' },
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
      setLine(base),
      'Set: mvt-indicators index b22ddf05e1a3, fetched 2026-10-15 UTC (e3fb2081f3e1). ' +
        'Newest indicator 2026-10-09 UTC: 6 day(s) old when checked.'
    );
    assert.equal(staleLine(base, 90), null);
    const old = { ...base, newest_indicator: '2026-05-01T00:00:00.000Z' };
    assert.equal(staleLine(old, 90), 'Older than 90 days when checked: indicators published since are not in it.');
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

  it('lists every type not checked, with why, in a fixed order', () => {
    assert.deepEqual(notCheckedLines(base), [
      'IP address (73): no source in any backup. an iOS backup keeps no network connection log.',
      'Bundle ID (684): no facts in this case: none of its sources held a value in this case.',
      'Not loaded from the set: 501 indicators. Of types no iOS backup holds (app certificates, Android properties, configuration profiles): 501.',
      'Not read: URLs inside message text are not read.',
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

  it('uses no verdict word', () => {
    const texts = [
      setLine(base),
      staleLine({ ...base, newest_indicator: '2025-01-01T00:00:00.000Z' }, 90) ?? '',
      resultLine(base, NOTHING),
      resultLine({ ...base, matches: 2 }, NOTHING),
      ...notCheckedLines(base),
      ...base.sources.map(sourceLine),
    ];
    for (const text of texts) assert.doesNotMatch(text, VERDICTS);
  });
});
