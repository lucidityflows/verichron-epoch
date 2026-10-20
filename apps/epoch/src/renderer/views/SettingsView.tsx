import React, { useEffect, useMemo, useState } from 'react';
import { ViewLayout } from '../components/layout/ViewLayout';
import { DateTime } from '../components/ui/DateTime';
import { EmptyState } from '../components/ui/EmptyState';
import { settingsApi } from '../api/settings';
import { useSettings, useSettingsStore } from '../store/useSettings';
import { DEFAULT_ZONE, zoneLabel } from '../../shared/time';

/** "UTC (default)", or "America/Chicago (CDT, UTC−05:00)" as it is now (board "Time Display Rules"). */
export function zoneOption(zone: string, now: Date): string {
  return zone === DEFAULT_ZONE ? 'UTC (default)' : `${zone} (${zoneLabel(now, zone)})`;
}

/**
 * Settings (EPOCH-560): the zone every time is shown in, in the app and in
 * reports. Times are stored in UTC (R11); this changes only how they are
 * shown. The main process keeps the setting, so it survives a restart and
 * every window follows it.
 */
export const SettingsView: React.FC = () => {
  const { displayZone } = useSettings();
  const setSettings = useSettingsStore((state) => state.setSettings);
  const [zones, setZones] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The preview shows the time now, ticking, in the zone chosen.
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let active = true;
    settingsApi.getDisplayZones().then(
      (list) => active && setZones(list),
      (err: unknown) => active && setError(err instanceof Error ? err.message : String(err))
    );
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => {
      active = false;
      clearInterval(tick);
    };
  }, []);

  // Each zone's label as it is today, worked out once per page, not every second.
  const [today] = useState(() => new Date());
  const options = useMemo(
    () => (zones ?? []).map((zone) => ({ zone, label: zoneOption(zone, today) })),
    [zones, today]
  );

  const choose = async (zone: string) => {
    setSaving(true);
    setError(null);
    try {
      setSettings(await settingsApi.setDisplayZone(zone));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ViewLayout
      section="settings"
      title="Settings"
      description="How Epoch shows what it reads, on this computer."
      width="readable"
    >
      {!zones && !error ? (
        <EmptyState loading title="Loading the settings…" />
      ) : (
        <section aria-labelledby="time-zone-title" className="card rounded-xl px-6 py-5 flex flex-col gap-4">
          <h2 id="time-zone-title" className="font-display text-heading text-foreground">
            Time Zone
          </h2>
          <label className="flex flex-col gap-1.5">
            <span className="text-label text-muted-foreground">Time zone</span>
            <select
              value={displayZone}
              disabled={saving || !zones}
              onChange={(event) => choose(event.target.value)}
              className="w-full max-w-md bg-background rounded-lg px-3 py-2 text-data text-foreground border border-border focus:border-accent focus:outline-none disabled:opacity-50"
            >
              {options.map(({ zone, label }) => (
                <option key={zone} value={zone}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-data text-foreground/90">
            Evidence times are stored in UTC. This changes only how times are shown, in the app and in reports.
          </p>
          <p className="text-data text-muted-foreground">
            A report states the zone it was written in and keeps it; the next analysis writes its report in the zone
            chosen here.
          </p>
          <div className="flex items-baseline gap-3 rounded-lg bg-inset px-4 py-3">
            <span className="text-label text-muted-foreground">Preview</span>
            <DateTime value={now} className="text-data text-foreground" />
          </div>
          {error && (
            // §1 state-colour banner: shadow-elevation-1 and a state-colour border together.
            <div
              role="alert"
              className="text-warning bg-warning/10 shadow-elevation-1 border border-warning/30 rounded-lg p-4 text-data"
            >
              The time zone could not be saved: {error}
            </div>
          )}
        </section>
      )}
    </ViewLayout>
  );
};
