/**
 * EPOCH-556: a record reads as a record. Values are made readable only from
 * what iLEAPP declared, encoded values are described, the stored value is
 * always available, and the summary never shows a number as anything else.
 */

import assert from 'node:assert/strict';
import type { ForensicRecordRow, RecordColumn } from '@verichron/etl-db-reader';
import { describe, it } from 'vitest';

import { fieldLines, noteLines, originOf, rawText, recordText, sourceTitle, summaryOf } from './recordText';

const row = (over: Partial<ForensicRecordRow>): ForensicRecordRow => ({
  id: '20418',
  ingest_id: '1',
  evidence_id: 'e',
  derivative_id: 'd',
  file_hash: 'a'.repeat(64),
  parser_version: 6,
  incident_id: null,
  source_type: 'ileapp_record',
  event_time: '2026-10-14T08:12:09Z',
  bug_type: null,
  process_name: null,
  pid: null,
  bundle_id: null,
  fields: {},
  tier: 'observed',
  ...over,
});

const SAFARI = {
  engine: 'iLEAPP',
  source_artifact: 'Safari Browser - History',
  module: 'safariHistory',
  category: 'Safari Browser',
  source_path: 'private/var/mobile/Library/Safari/History.db',
  'Visit Timestamp': 1791972729,
  URL: 'https://update-check.example.invalid/a',
  'Visit Count': 3,
};
const COLUMNS: RecordColumn[] = [
  { column: 'visit_timestamp', header: 'Visit Timestamp', type: 'datetime' },
  { column: 'url', header: 'URL', type: null },
  { column: 'visit_count', header: 'Visit Count', type: null },
];

describe('a record read by its declared types', () => {
  it("shows a declared time in the examiner's zone, with the stored seconds beside it", () => {
    const lines = fieldLines(SAFARI, COLUMNS, 'America/Chicago');
    assert.deepEqual(lines, [
      { name: 'Visit Timestamp', value: '2026-10-14 05:12:09 CDT, UTC−05:00', stored: '1791972729' },
      { name: 'URL', value: 'https://update-check.example.invalid/a', stored: null },
      { name: 'Visit Count', value: '3', stored: null },
    ]);
  });

  it('never formats an undeclared number as a time', () => {
    const [count] = fieldLines(
      { 'Visit Count': 1791972729 },
      [{ column: 'c', header: 'Visit Count', type: null }],
      'UTC'
    );
    assert.equal(count.value, '1791972729');
    const [unknown] = fieldLines({ Created: 1286762054 }, null, 'UTC');
    assert.equal(unknown.value, '1286762054', 'no column types recorded: shown as stored');
  });

  it('describes an encoded value and says when a value is missing', () => {
    const lines = fieldLines(
      {
        Blob: { $encoded: 'hex', value: '00ff10' },
        Text: { $encoded: 'utf8-hex', value: Buffer.from('a\u0000b').toString('hex') },
        Rate: { $encoded: 'float', value: 'Infinity' },
        Empty: null,
      },
      null,
      'UTC'
    );
    assert.deepEqual(
      lines.map((l) => [l.name, l.value, l.stored]),
      [
        ['Blob', 'binary data, 3 bytes', '{"$encoded":"hex","value":"00ff10"}'],
        ['Text', 'a\u0000b', '{"$encoded":"utf8-hex","value":"610062"}'],
        ['Rate', 'Infinity', '{"$encoded":"float","value":"Infinity"}'],
        ['Empty', 'not recorded', null],
      ]
    );
  });

  it('keeps where it came from and the stage’s notes out of the fields', () => {
    const fields = {
      ...SAFARI,
      corrections: [{ defect: 'ILEAPP-0001' }],
      time_review: [{ check: 'before_device_era' }],
    };
    const names = fieldLines(fields, COLUMNS, 'UTC').map((l) => l.name);
    assert.deepEqual(names, ['Visit Timestamp', 'URL', 'Visit Count']);
    assert.deepEqual(
      noteLines(fields).map((n) => n.name),
      ['Corrected', 'Time kept for review']
    );
  });
});

describe('a record in one line', () => {
  it('summarizes an iLEAPP record by its text values, never its numbers', () => {
    assert.equal(summaryOf(row({ fields: SAFARI })), 'https://update-check.example.invalid/a');
  });

  it('names a crash report by its process and bug type, and a match by what it matched', () => {
    assert.equal(
      summaryOf(row({ source_type: 'crash_report', process_name: 'SpringBoard', bug_type: '309' })),
      'SpringBoard · bug type 309'
    );
    assert.equal(
      summaryOf(
        row({ source_type: 'indicator_match', fields: { indicator: { type: 'domain', value: 'evil.example' } } })
      ),
      'Matched domain evil.example'
    );
  });

  it('names where a record is from', () => {
    assert.equal(originOf(row({ fields: SAFARI })), 'Safari Browser - History');
    assert.equal(originOf(row({ source_type: 'crash_report' })), 'Crash Reports');
    assert.equal(sourceTitle('indicator_match'), 'Indicator Matches');
  });
});

describe('the two copies', () => {
  it('copies the record as it reads, and the raw data exactly as stored', () => {
    const r = row({ fields: SAFARI });
    const text = recordText(r, fieldLines(SAFARI, COLUMNS, 'UTC'), 'UTC');
    assert.equal(
      text,
      [
        'Safari Browser - History · record 20418',
        'Time: 2026-10-14 08:12:09 UTC',
        'Visit Timestamp: 2026-10-14 10:12:09 UTC',
        'URL: https://update-check.example.invalid/a',
        'Visit Count: 3',
      ].join('\n')
    );
    assert.deepEqual(JSON.parse(rawText(r)).fields, SAFARI);
  });
});
