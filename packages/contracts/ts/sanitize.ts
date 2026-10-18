/**
 * The task log's sanitizer (EPOCH-570, docs/event-log.md §6). It replaces
 * only exact values the workspace and the workstation themselves report,
 * matched as whole tokens: no pattern guesses at what might be an identifier,
 * because guessing produced false positives (§6.3). Values are never printed,
 * not even in its notices.
 *
 * Order matters and is fixed: secrets (the tripwire), then workstation roots
 * (most specific first), then device identifiers, then the account name inside
 * a path.
 */

/** What a replacement removed. Its count is reported; its value never is. */
export type SanitizedClass =
  | 'password'
  | 'workspace'
  | 'source'
  | 'app'
  | 'temp'
  | 'home'
  | 'device'
  | 'device-guid'
  | 'serial'
  | 'imei'
  | 'meid'
  | 'iccid'
  | 'phone'
  | 'user';

/** One backup's identifiers, as the workspace recorded them. */
export interface DeviceIdentifierSource {
  /** The backup's dated label, for notices. */
  label: string;
  /** What markers call the device: `[device <name>]`. Must contain none of its identifiers. */
  name: string;
  /** The folder that holds Manifest.db, whose name is the UDID when idevicebackup2 or Finder wrote it. */
  folderName: string | null;
  /** Info.plist's top-level strings, or null when it could not be read. */
  infoPlist: ReadonlyMap<string, string> | null;
}

/** The examiner's workstation, as absolute paths and the account name. */
export interface WorkstationRoots {
  workspace?: string | null;
  source?: string | null;
  app?: string | null;
  temp?: string | null;
  home?: string | null;
  user?: string | null;
}

/** A value that could not be used, named by its class and label, never by its value. */
export interface SanitizerNotice {
  label: string | null;
  class: SanitizedClass;
  reason: string;
}

export interface SanitizeReport {
  text: string;
  replaced: Partial<Record<SanitizedClass, number>>;
}

const UDID = /^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$/;

/** Info.plist keys, the class each belongs to, and the form a value must have to be used (§6.3). */
const INFO_PLIST_CLASSES: readonly { key: string; cls: SanitizedClass; form: RegExp }[] = [
  { key: 'Unique Identifier', cls: 'device', form: UDID },
  { key: 'Target Identifier', cls: 'device', form: UDID },
  { key: 'GUID', cls: 'device-guid', form: /^[0-9A-Fa-f]{32}$/ },
  { key: 'Serial Number', cls: 'serial', form: /^[A-Z0-9]{8,14}$/ },
  { key: 'IMEI', cls: 'imei', form: /^\d{15}$/ },
  { key: 'IMEI 2', cls: 'imei', form: /^\d{15}$/ },
  { key: 'MEID', cls: 'meid', form: /^[0-9A-Fa-f]{14}$/ },
  { key: 'ICCID', cls: 'iccid', form: /^\d{19,20}$/ },
  { key: 'Phone Number', cls: 'phone', form: /\d/ },
];

/** Roots, most specific first when two are the same length. */
const ROOT_ORDER = ['workspace', 'source', 'app', 'temp', 'home'] as const;
const ROOT_MARKER: Record<(typeof ROOT_ORDER)[number], string> = {
  workspace: '<workspace>',
  source: '<source>',
  app: '<app>',
  temp: '<temp>',
  home: '~',
};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Characters that end a path, or may sit just before one, in log text. */
const PATH_EDGE = `\\s'"()\\[\\],;:<>|=`;
/** A path as it appears in a line once its roots are replaced: an optional root marker, then `/…`. */
const PATH_TOKEN = new RegExp(`(?:<(?:workspace|source|app|temp)>|~)?/[^\\s'"()\\[\\],;<>|]*`, 'g');

interface Rule {
  cls: SanitizedClass;
  pattern: RegExp;
  marker: string;
  /** Longer values first, so a value inside another is never replaced first. */
  length: number;
}

function wholeToken(value: string, flags: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escape(value)}(?![A-Za-z0-9])`, flags);
}

function digitsOnly(value: string): RegExp {
  return new RegExp(`(?<!\\d)${escape(value)}(?!\\d)`, 'g');
}

export class Sanitizer {
  private readonly secrets = new Set<string>();

  private constructor(
    private readonly roots: Rule[],
    private readonly identifiers: Rule[],
    private readonly user: RegExp | null,
    /** Every value it replaces, for `residue`: never printed, never returned. */
    private readonly known: { cls: SanitizedClass; value: string }[],
    private readonly userName: string | null,
    /** Values that were not used, and why. */
    readonly notices: SanitizerNotice[]
  ) {}

  static create(devices: readonly DeviceIdentifierSource[], workstation: WorkstationRoots): Sanitizer {
    const notices: SanitizerNotice[] = [];
    const roots: Rule[] = [];
    const known: { cls: SanitizedClass; value: string }[] = [];
    for (const name of ROOT_ORDER) {
      const raw = workstation[name];
      if (!raw) continue;
      const root = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
      if (!root.startsWith('/') || root === '/' || root.length < 2) {
        notices.push({ label: null, class: name, reason: 'it is not an absolute folder, so it is not used' });
        continue;
      }
      known.push({ cls: name, value: root });
      roots.push({
        cls: name,
        pattern: new RegExp(`(?<=^|[${PATH_EDGE}])${escape(root)}(?=$|[/${PATH_EDGE}])`, 'g'),
        marker: ROOT_MARKER[name],
        length: root.length,
      });
    }
    // Longest first; equal lengths keep ROOT_ORDER (the sort is stable).
    roots.sort((a, b) => b.length - a.length);

    const identifiers: Rule[] = [];
    for (const device of devices) {
      const add = (cls: SanitizedClass, value: string, pattern: RegExp) => {
        identifiers.push({ cls, pattern, marker: `[${cls} ${device.name}]`, length: value.length });
        known.push({ cls, value });
      };
      const values: string[] = [];
      if (device.folderName && UDID.test(device.folderName)) {
        values.push(device.folderName);
        add('device', device.folderName, wholeToken(device.folderName, 'gi'));
      }
      if (device.infoPlist === null) {
        notices.push({
          label: device.label,
          class: 'device',
          reason: 'its Info.plist could not be read, so only its folder name is replaced',
        });
      } else {
        for (const { key, cls, form } of INFO_PLIST_CLASSES) {
          const value = device.infoPlist.get(key)?.trim();
          if (!value) continue;
          if (!form.test(value)) {
            notices.push({
              label: device.label,
              class: cls,
              reason: `its "${key}" does not have the expected form, so it is not used`,
            });
            continue;
          }
          values.push(value);
          add(cls, value, wholeToken(value, 'gi'));
          if (cls === 'phone') {
            const digits = value.replace(/\D/g, '');
            if (digits.length >= 7) {
              values.push(digits);
              add('phone', digits, digitsOnly(digits));
              add('phone', `+${digits}`, new RegExp(`\\+${digits}(?!\\d)`, 'g'));
              if (digits.length > 10) add('phone', digits.slice(-10), digitsOnly(digits.slice(-10)));
            }
          }
        }
      }
      const leaked = values.find((v) => device.name.toLowerCase().includes(v.toLowerCase()));
      if (leaked !== undefined) {
        throw new Error(`the name for ${device.label}'s markers contains one of its identifiers; choose another name`);
      }
    }
    identifiers.sort((a, b) => b.length - a.length);

    let user: RegExp | null = null;
    if (workstation.user) {
      if (/^[A-Za-z0-9._-]{3,}$/.test(workstation.user)) user = wholeToken(workstation.user, 'g');
      else
        notices.push({
          label: null,
          class: 'user',
          reason: 'the account name is too short or unusual to match safely, so it is not used',
        });
    }
    return new Sanitizer(roots, identifiers, user, known, user ? workstation.user! : null, notices);
  }

  /** A password the examiner entered for this task: the tripwire (§6.2). Held only until `clearSecrets()`. */
  addSecret(value: string): void {
    if (value) this.secrets.add(value);
  }

  clearSecrets(): void {
    this.secrets.clear();
  }

  sanitize(text: string): string {
    return this.report(text).text;
  }

  /** The sanitized text and how many of each class were replaced. */
  report(text: string): SanitizeReport {
    const replaced: Partial<Record<SanitizedClass, number>> = {};
    const count = (cls: SanitizedClass) => (replaced[cls] = (replaced[cls] ?? 0) + 1);
    const apply = (input: string, rule: Rule) =>
      input.replace(rule.pattern, () => {
        count(rule.cls);
        return rule.marker;
      });

    let out = text;
    // A password is matched anywhere, even inside a longer token: missing one
    // costs more than the occasional false alarm (owner, 2026-10-18).
    for (const secret of this.secrets) {
      out = apply(out, { cls: 'password', pattern: new RegExp(escape(secret), 'g'), marker: '[password]', length: 0 });
    }
    for (const rule of this.roots) out = apply(out, rule);
    for (const rule of this.identifiers) out = apply(out, rule);
    const user = this.user;
    if (user) {
      out = out.replace(PATH_TOKEN, (path) =>
        path.replace(user, () => {
          count('user');
          return '<user>';
        })
      );
    }
    return { text: out, replaced };
  }

  /**
   * What is left of a known value in text that was already sanitized: the
   * real-data check (docs/event-log.md §6.5). Stricter than replacement: any
   * occurrence counts, inside a longer token too, and the account name counts
   * anywhere inside a path. Classes and counts only; never a value.
   */
  residue(text: string): Partial<Record<SanitizedClass, number>> {
    const found: Partial<Record<SanitizedClass, number>> = {};
    const count = (cls: SanitizedClass, n: number) => {
      if (n > 0) found[cls] = (found[cls] ?? 0) + n;
    };
    const lower = text.toLowerCase();
    // One value can be known more than once (a UDID is the folder name and two Info.plist keys).
    const distinct = new Map(this.known.map((k) => [`${k.cls}\u0000${k.value.toLowerCase()}`, k]));
    for (const { cls, value } of distinct.values()) {
      const isRoot = ROOT_ORDER.includes(cls as (typeof ROOT_ORDER)[number]);
      const haystack = isRoot ? text : lower;
      const needle = isRoot ? value : value.toLowerCase();
      count(cls, haystack.split(needle).length - 1);
    }
    if (this.userName) {
      const name = this.userName;
      for (const path of text.match(PATH_TOKEN) ?? []) count('user', path.split(name).length - 1);
    }
    return found;
  }

  /** Every string in a value (an event, a header), sanitized; the shape is unchanged. */
  sanitizeDeep<T>(value: T): T {
    if (typeof value === 'string') return this.sanitize(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.sanitizeDeep(v)) as T;
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.sanitizeDeep(v)])) as T;
    }
    return value;
  }
}
