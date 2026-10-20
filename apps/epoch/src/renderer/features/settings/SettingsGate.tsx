import React, { useEffect, useState } from 'react';
import { settingsApi } from '../../api/settings';
import { useSettingsStore } from '../../store/useSettings';

/**
 * Loads the examiner's settings before anything renders, then follows every
 * change made in any window (EPOCH-560): no time is ever shown in a zone
 * other than the one chosen. Settings that can't be read are an error that
 * names the file, never replaced by the defaults.
 */
export function SettingsGate({ children }: { children: React.ReactNode }) {
  const loaded = useSettingsStore((state) => state.settings !== null);
  const setSettings = useSettingsStore((state) => state.setSettings);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // A change from another window can arrive before the first read answers;
    // the read is then older than the change and is not applied (CodeRabbit, PR #138).
    let changed = false;
    const stop = settingsApi.onSettingsChanged((settings) => {
      changed = true;
      setSettings(settings);
    });
    settingsApi.getSettings().then(
      (settings) => active && !changed && setSettings(settings),
      (err: unknown) => active && !changed && setError(err instanceof Error ? err.message : String(err))
    );
    return () => {
      active = false;
      stop();
    };
  }, [setSettings]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-8">
        {/* §1 state-colour banner: shadow-elevation-1 and a state-colour border together. */}
        <div
          role="alert"
          className="max-w-2xl text-warning bg-warning/10 shadow-elevation-1 border border-warning/30 rounded-lg p-4 text-data"
        >
          <p className="font-semibold">Epoch's settings could not be read</p>
          <p className="mt-1 text-foreground/90">{error}</p>
        </div>
      </div>
    );
  }
  return loaded ? <>{children}</> : null;
}
