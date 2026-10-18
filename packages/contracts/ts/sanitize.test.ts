/**
 * The task log's sanitizer (EPOCH-570, docs/event-log.md §6.5). The values
 * here are synthetic, in the real formats: real identifiers never go in this
 * repository. The real-data check runs locally against the owner's workspace.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Sanitizer, type DeviceIdentifierSource } from './sanitize.js';

const UDID = '00008030-000A1B2C3D4E5F60';
const LABEL = '2026-10-15T180523Z';

function plist(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

const DEVICE: DeviceIdentifierSource = {
  label: LABEL,
  name: LABEL,
  folderName: UDID,
  infoPlist: plist({
    'Unique Identifier': UDID,
    'Target Identifier': UDID,
    GUID: '0123456789ABCDEF0123456789ABCDEF',
    'Serial Number': 'F2LZK1ABCD12',
    IMEI: '356789012345678',
    ICCID: '8901260123456789012',
    'Phone Number': '+1 (555) 010-4477',
    'Device Name': 'iPhone',
    'Display Name': 'iPhone',
    'Product Type': 'iPhone17,5',
    'Product Version': '26.6.1',
  }),
};

const ROOTS = {
  workspace: '/home/examiner/verichron-workspace',
  source: '/home/examiner/Downloads',
  app: '/home/examiner/verichron-epoch',
  temp: '/tmp',
  home: '/home/examiner',
  user: 'examiner',
};

const sanitizer = () => Sanitizer.create([DEVICE], ROOTS);

describe('device identifiers', () => {
  it('replaces a UDID in a source path with a marker naming the label', () => {
    assert.equal(
      sanitizer().sanitize(`  - ${LABEL}  (/home/examiner/Downloads/${LABEL}/${UDID})`),
      `  - ${LABEL}  (<source>/${LABEL}/[device ${LABEL}])`
    );
  });

  it('matches regardless of case, as a whole token only', () => {
    const s = sanitizer();
    assert.equal(s.sanitize(`udid ${UDID.toLowerCase()}.`), `udid [device ${LABEL}].`);
    assert.equal(s.sanitize(`hash ab${UDID}cd`), `hash ab${UDID}cd`, 'inside a longer token it is not the identifier');
  });

  it('replaces each Info.plist class with its own marker', () => {
    const report = sanitizer().report(
      'serial F2LZK1ABCD12 imei 356789012345678 iccid 8901260123456789012 guid 0123456789abcdef0123456789abcdef'
    );
    assert.equal(
      report.text,
      `serial [serial ${LABEL}] imei [imei ${LABEL}] iccid [iccid ${LABEL}] guid [device-guid ${LABEL}]`
    );
    assert.deepEqual(report.replaced, { serial: 1, imei: 1, iccid: 1, 'device-guid': 1 });
  });

  it('replaces a phone number as stored and in its digit forms, never inside a longer number', () => {
    const s = sanitizer();
    const marker = `[phone ${LABEL}]`;
    assert.equal(s.sanitize('number +1 (555) 010-4477'), `number ${marker}`);
    assert.equal(s.sanitize('tel:+15550104477;'), `tel:${marker};`);
    assert.equal(s.sanitize('digits 15550104477 and 5550104477'), `digits ${marker} and ${marker}`);
    assert.equal(s.sanitize('id 9155501044771'), 'id 9155501044771');
  });

  it('never replaces the Device Name: a common word gave a false positive on a real log', () => {
    const s = sanitizer();
    const line = '[processor] decrypt: iphone_backup_decrypt 0.10.0 · NOTE: application com.example.iphone.app';
    assert.equal(s.sanitize(line), line);
    assert.equal(s.sanitize('iPhone17,5 · iOS 26.6.1'), 'iPhone17,5 · iOS 26.6.1', 'model and iOS version stay');
  });

  it('does not use a value without the expected form, and says so without the value', () => {
    const odd = Sanitizer.create(
      [{ ...DEVICE, folderName: LABEL, infoPlist: plist({ 'Serial Number': 'short', IMEI: '12345' }) }],
      {}
    );
    assert.equal(odd.sanitize('short 12345'), 'short 12345');
    assert.deepEqual(
      odd.notices.map((n) => [n.label, n.class]),
      [
        [LABEL, 'serial'],
        [LABEL, 'imei'],
      ]
    );
    assert.ok(odd.notices.every((n) => !n.reason.includes('short') && !n.reason.includes('12345')));
  });

  it('still replaces the folder name when Info.plist could not be read', () => {
    const s = Sanitizer.create([{ ...DEVICE, infoPlist: null }], {});
    assert.equal(s.sanitize(`/${UDID}/Manifest.db`), `/[device ${LABEL}]/Manifest.db`);
    assert.deepEqual(
      s.notices.map((n) => n.class),
      ['device']
    );
  });

  it('refuses a marker name that contains an identifier', () => {
    assert.throws(() => Sanitizer.create([{ ...DEVICE, name: UDID }], {}), /contains one of its identifiers/);
  });
});

describe('workstation roots', () => {
  it('replaces the most specific root first', () => {
    const s = sanitizer();
    assert.equal(s.sanitize('done -> /home/examiner/verichron-workspace/ileapp/x'), 'done -> <workspace>/ileapp/x');
    assert.equal(s.sanitize('iLEAPP (/home/examiner/verichron-epoch/tools/ileapp)'), 'iLEAPP (<app>/tools/ileapp)');
    assert.equal(s.sanitize('read /home/examiner/notes.txt'), 'read ~/notes.txt');
    assert.equal(
      s.sanitize('--workspace /home/examiner/verichron-workspace --only x'),
      '--workspace <workspace> --only x'
    );
  });

  it('matches a root only as a whole path prefix', () => {
    const s = sanitizer();
    // Not the home root (no "~"), but the account name is still a whole token in the path.
    assert.equal(s.sanitize('/home/examiner-old/x'), '/home/<user>-old/x');
    assert.equal(s.sanitize('/data/home/examiner/x'), '/data/home/examiner/x'.replace('examiner', '<user>'));
    assert.equal(s.sanitize("'/home/examiner/Downloads'"), "'<source>'");
  });

  it('replaces the account name inside a path, never in free text', () => {
    const s = sanitizer();
    assert.equal(
      s.sanitize('summary /tmp/claude-1000/-home-examiner-verichron-epoch/summary.json'),
      'summary <temp>/claude-1000/-home-<user>-verichron-epoch/summary.json'
    );
    assert.equal(s.sanitize('/media/examiner/USB/backup'), '/media/<user>/USB/backup');
    assert.equal(s.sanitize('the examiner chose a folder'), 'the examiner chose a folder');
  });

  it('does not use a root that is not an absolute folder, or an account name too short to match safely', () => {
    const s = Sanitizer.create([], { workspace: 'relative/ws', home: '/', user: 'ab' });
    assert.equal(s.sanitize('relative/ws / ab /x/ab/y'), 'relative/ws / ab /x/ab/y');
    assert.deepEqual(
      s.notices.map((n) => n.class),
      ['workspace', 'home', 'user']
    );
  });
});

describe('secrets', () => {
  it('replaces a password that reached the output, as a whole token, until the task ends (tripwire)', () => {
    const s = sanitizer();
    s.addSecret('correct-horse');
    const report = s.report('error: wrong key correct-horse; correct-horses');
    assert.equal(report.text, 'error: wrong key [password]; correct-horses');
    assert.deepEqual(report.replaced, { password: 1 });
    s.clearSecrets();
    assert.equal(s.sanitize('correct-horse'), 'correct-horse');
  });
});

describe('sanitizeDeep', () => {
  it('sanitizes every string in an event and keeps its shape', () => {
    const event = { type: 'registration:refused', backup_path: `/home/examiner/Downloads/${LABEL}/${UDID}`, n: 3 };
    assert.deepEqual(sanitizer().sanitizeDeep(event), {
      type: 'registration:refused',
      backup_path: `<source>/${LABEL}/[device ${LABEL}]`,
      n: 3,
    });
  });
});

describe('residue', () => {
  it('finds any known value left in sanitized text, inside a longer token too, and names only its class', () => {
    const s = sanitizer();
    assert.deepEqual(s.residue(s.sanitize(`(/home/examiner/Downloads/${LABEL}/${UDID})`)), {}, 'nothing left');
    assert.deepEqual(s.residue(`hash ab${UDID.toLowerCase()}cd in /var/examiner/x and the examiner`), {
      device: 1,
      user: 1,
    });
    assert.deepEqual(s.residue('see /home/examiner'), { home: 1, user: 1 });
  });
});
