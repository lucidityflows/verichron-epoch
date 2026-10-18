import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import type { DeviceIdentifierSource } from './sanitize.js';

const XML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

/**
 * Top-level `<key>` / `<string>` and `<key>` / `<date>` pairs of an XML
 * property list, such as a backup's Info.plist. iTunes, Finder and
 * idevicebackup2 write Info.plist as XML; a binary property list is refused
 * rather than guessed at.
 */
export function readPlistValues(file: string): Map<string, string> {
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 8).toString('latin1') === 'bplist00') {
    throw new Error(`${file} is a binary property list; only XML is supported`);
  }
  const text = bytes.toString('utf8');
  const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e]);
  const out = new Map<string, string>();
  for (const match of text.matchAll(/<key>([^<]*)<\/key>\s*<(string|date)>([^<]*)<\/\2>/g)) {
    out.set(decode(match[1]), decode(match[3]));
  }
  return out;
}

/** A shape any of a backup's identifiers can have; a label like this is never used as a marker's name. */
const IDENTIFIER_SHAPED = /^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40}|[0-9A-Fa-f]{32})$/;

const IDENTIFIER_KEYS = [
  'Unique Identifier',
  'Target Identifier',
  'GUID',
  'Serial Number',
  'IMEI',
  'IMEI 2',
  'MEID',
  'ICCID',
  'Phone Number',
];

/**
 * What the sanitizer needs to know about each backup (docs/event-log.md §6.3):
 * its folder name and Info.plist, and the name its markers use.
 *
 * A marker is named by the backup's dated label. A label that is, or holds,
 * one of the backup's identifiers (a backup kept in a folder named by its
 * UDID, as Finder does) is replaced by the device model, iOS version and
 * backup date, with a counter when two would read the same (owner,
 * 2026-10-18).
 */
export function deviceIdentifierSources(backups: readonly { label: string; path: string }[]): DeviceIdentifierSource[] {
  const sources = backups.map((backup) => {
    let infoPlist: Map<string, string> | null;
    try {
      infoPlist = readPlistValues(path.join(backup.path, 'Info.plist'));
    } catch {
      infoPlist = null;
    }
    const folderName = path.basename(backup.path);
    // The folder name is an identifier only when it has a UDID's shape; a dated
    // or plain folder (often the label itself) is not.
    const identifiers = [
      IDENTIFIER_SHAPED.test(folderName) ? folderName : undefined,
      ...IDENTIFIER_KEYS.map((key) => infoPlist?.get(key)?.trim()),
    ].filter((value): value is string => !!value && value.length >= 6);
    const label = backup.label.toLowerCase();
    const labelIsIdentifier =
      IDENTIFIER_SHAPED.test(backup.label) || identifiers.some((value) => label.includes(value.toLowerCase()));
    return { backup, infoPlist, folderName, name: labelIsIdentifier ? describeDevice(infoPlist) : backup.label };
  });

  const seen = new Map<string, number>();
  return sources.map(({ backup, infoPlist, folderName, name }) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return { label: backup.label, name: n === 1 ? name : `${name} (${n})`, folderName, infoPlist };
  });
}

/** "iPhone17,5 · iOS 26.6.1 · 2026-10-15", from what Info.plist says; "backup" when it says none of it. */
function describeDevice(infoPlist: ReadonlyMap<string, string> | null): string {
  const model = infoPlist?.get('Product Type')?.trim();
  const ios = infoPlist?.get('Product Version')?.trim();
  const date = infoPlist?.get('Last Backup Date')?.trim().slice(0, 10);
  const parts = [model, ios ? `iOS ${ios}` : undefined, date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined];
  const name = parts.filter(Boolean).join(' · ');
  return name || 'backup';
}
