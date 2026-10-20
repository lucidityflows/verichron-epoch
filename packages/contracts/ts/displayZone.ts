/**
 * The zone times are shown in (EPOCH-560): UTC, the default, or a named IANA
 * zone the examiner chose, such as "America/Chicago". Times are stored in UTC
 * (R11); the zone changes only how they are shown, in the app and in reports.
 *
 * Only named zones are accepted (project owner, 2026-10-18). An abbreviation
 * ("CST"), a fixed offset ("+05:30", "Etc/GMT+5") or a POSIX rule
 * ("CST6CDT") is refused: none of them says where the clocks change, so none
 * names a place's time. A zone is accepted only as this runtime's zone
 * database spells it (CodeRabbit, PR #138): the runtime would read
 * "america/chicago" or "Asia/Kolkata" as America/Chicago or Asia/Calcutta,
 * but the report's database is case-sensitive, so one spelling is kept. The
 * Python copy is `display_zone.py`; both read the cases in
 * `testdata/display_zone_cases.json`.
 */

export const DEFAULT_DISPLAY_ZONE = 'UTC';

/** Area/Location, as the IANA database names its zones ("America/Argentina/Salta" has two levels). */
const NAMED_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/;

/** The runtime's own spelling of a zone ("Asia/Calcutta" for "asia/kolkata"), or null when it has none. */
function spelling(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** True for UTC or a named zone, spelled exactly as this runtime's zone database spells it. */
export function isDisplayZone(zone: string): boolean {
  if (zone === DEFAULT_DISPLAY_ZONE) return true;
  if (!NAMED_ZONE.test(zone) || zone.startsWith('Etc/')) return false;
  return spelling(zone) === zone;
}

/** The zone, or an error saying why it can't be used, and how to spell it when that is all that is wrong. */
export function displayZone(zone: string): string {
  if (!isDisplayZone(zone)) {
    const known = NAMED_ZONE.test(zone) ? spelling(zone) : null;
    const hint = known && isDisplayZone(known) ? `; Epoch spells this zone "${known}"` : '';
    throw new Error(
      `"${zone}" is not a time zone Epoch can show times in: use UTC or a named zone such as America/Chicago${hint}`
    );
  }
  return zone;
}

/** Every zone the examiner can choose, UTC first, then the named zones in order. */
export function displayZones(): string[] {
  return [DEFAULT_DISPLAY_ZONE, ...Intl.supportedValuesOf('timeZone').filter(isDisplayZone).sort()];
}
