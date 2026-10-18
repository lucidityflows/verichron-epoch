/**
 * Who the sanitizer's markers name, and the wording events are shown in
 * (EPOCH-570). Synthetic values in the real formats.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { deviceIdentifierSources, readPlistValues } from './deviceIdentifiers.js';
import { eventMessage, formatBytes } from './pipelineEvent.js';
import { ProcessorSummary } from './processorSummary.js';
import { Sanitizer } from './sanitize.js';

const UDID = '00008030-000A1B2C3D4E5F60';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'device-identifiers-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function backup(folder: string, entries: Record<string, string> | 'binary' | null): string {
  const dir = path.join(tmp, folder);
  mkdirSync(dir, { recursive: true });
  if (entries === 'binary') writeFileSync(path.join(dir, 'Info.plist'), 'bplist00...');
  else if (entries) {
    const body = Object.entries(entries)
      .map(([k, v]) =>
        k.endsWith('Date') ? `<key>${k}</key><date>${v}</date>` : `<key>${k}</key><string>${v}</string>`
      )
      .join('\n');
    writeFileSync(path.join(dir, 'Info.plist'), `<?xml version="1.0"?><plist><dict>\n${body}\n</dict></plist>`);
  }
  return dir;
}

const PLIST = {
  'Unique Identifier': UDID,
  'Product Type': 'iPhone12,1',
  'Product Version': '18.1',
  'Last Backup Date': '2026-10-14T20:55:31Z',
  'Display Name': 'Kim &amp; Lee',
};

describe('readPlistValues', () => {
  it('reads top-level strings and dates, decoding entities, and refuses a binary list', () => {
    const values = readPlistValues(path.join(backup('read', PLIST), 'Info.plist'));
    assert.equal(values.get('Last Backup Date'), '2026-10-14T20:55:31Z');
    assert.equal(values.get('Display Name'), 'Kim & Lee');
    assert.throws(() => readPlistValues(path.join(backup('binary', 'binary'), 'Info.plist')), /binary property list/);
  });
});

describe('deviceIdentifierSources', () => {
  it('names markers by the dated label', () => {
    const dir = backup(path.join('2026-10-15T180523Z', UDID), PLIST);
    const [source] = deviceIdentifierSources([{ label: '2026-10-15T180523Z', path: dir }]);
    assert.equal(source.name, '2026-10-15T180523Z');
    assert.equal(source.folderName, UDID);
    assert.equal(source.infoPlist?.get('Unique Identifier'), UDID);
  });

  it('names a backup whose label is its UDID by model, iOS version and date, with a counter for a twin', () => {
    const first = backup(path.join('finder-a', UDID), PLIST);
    const second = backup(path.join('finder-b', '00008030-000A1B2C3D4E5F61'), {
      ...PLIST,
      'Unique Identifier': '00008030-000A1B2C3D4E5F61',
    });
    const sources = deviceIdentifierSources([
      { label: UDID, path: first },
      { label: '00008030-000A1B2C3D4E5F61', path: second },
    ]);
    assert.deepEqual(
      sources.map((s) => s.name),
      ['iPhone12,1 · iOS 18.1 · 2026-10-14', 'iPhone12,1 · iOS 18.1 · 2026-10-14 (2)']
    );
    const sanitizer = Sanitizer.create(sources, {});
    assert.equal(
      sanitizer.sanitize(`/x/${UDID}/Manifest.db`),
      `/x/[device iPhone12,1 · iOS 18.1 · 2026-10-14]/Manifest.db`
    );
  });

  it('keeps the label as the name when the folder is the label itself, not a UDID', () => {
    const dir = backup('BK1', PLIST);
    const [source] = deviceIdentifierSources([{ label: 'BK1', path: dir }]);
    assert.equal(source.name, 'BK1');
  });

  it('keeps going when Info.plist is missing or binary, and the sanitizer says so', () => {
    const sources = deviceIdentifierSources([
      { label: 'none', path: backup('none', null) },
      { label: 'binary', path: backup('binary-2', 'binary') },
    ]);
    assert.deepEqual(
      sources.map((s) => s.infoPlist),
      [null, null]
    );
    assert.equal(Sanitizer.create(sources, {}).notices.length, 2);
  });
});

describe('event wording', () => {
  it('writes each event as one sentence, without the label it is shown beside', () => {
    const label = '2026-10-15T180523Z';
    assert.equal(
      eventMessage({ type: 'backup:step', label, step: 'hash', status: 'done', detail: '9,870 files' }),
      'Checking the backup files: done (9,870 files)'
    );
    assert.equal(
      eventMessage({ type: 'backup:step', label, step: 'decrypt', status: 'error', reason: 'the password was wrong' }),
      'Decrypting failed: the password was wrong'
    );
    assert.equal(
      eventMessage({ type: 'decrypt:progress', label, bytes: 31_200_000_000, total: 58_400_000_000 }),
      'Decrypting: 31.2 GB of 58.4 GB'
    );
    assert.equal(
      eventMessage({ type: 'backup:finished', label, success: false, failed_step: 'ileapp', reason: 'x' }),
      'Not prepared: reading device activity with iLEAPP failed'
    );
    assert.equal(
      eventMessage({ type: 'prepare:finished', failed_labels: [label] }),
      'Prepare Evidence finished: 1 backup needs attention'
    );
  });

  it('formats sizes in decimal units', () => {
    assert.deepEqual(
      [formatBytes(999), formatBytes(12_304), formatBytes(312_000_000)],
      ['999 bytes', '12.3 KB', '312.0 MB']
    );
  });
});

describe('ProcessorSummary', () => {
  it('requires a failed backup to name its step and reason, and a prepared one neither', () => {
    const ok = { label: 'a', success: true, decrypted: true, failed_step: null, reason: null };
    assert.ok(ProcessorSummary.parse({ backups: [ok] }));
    assert.throws(() => ProcessorSummary.parse({ backups: [{ ...ok, success: false }] }));
    assert.ok(ProcessorSummary.parse({ backups: [{ ...ok, success: false, failed_step: 'hash', reason: 'r' }] }));
  });
});
