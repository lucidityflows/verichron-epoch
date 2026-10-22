/**
 * EPOCH-560: the zone every time is shown in. The settings load before
 * anything renders, a zone chosen in Settings changes every time shown and
 * each still says its zone, and a change made in another window arrives.
 */

import assert from 'node:assert/strict';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { AppSettings } from '../../../shared/types/window';
import { DateTime } from '../../components/ui/DateTime';
import { useSettingsStore } from '../../store/useSettings';
import { SettingsView, zoneOption } from '../../views/SettingsView';
import { SettingsGate } from './SettingsGate';

let stored: AppSettings;
let changed: ((settings: AppSettings) => void) | null;
let readError: Error | null;
let readGate: Promise<void> | null;
const setDisplayZone = vi.fn(async (zone: string) => (stored = { ...stored, displayZone: zone }));

vi.stubGlobal('epoch', {
  invoke: async (channel: string, zone?: string) => {
    if (channel === 'epoch:getSettings') {
      const answer = stored;
      if (readGate) await readGate;
      if (readError) throw readError;
      if (readGate) return answer;
      return stored;
    }
    if (channel === 'epoch:getDisplayZones') return ['UTC', 'America/Chicago', 'Asia/Kolkata'];
    if (channel === 'epoch:setDisplayZone') return setDisplayZone(zone!);
    throw new Error(`Unexpected IPC invoke: ${channel}`);
  },
  on: (channel: string, callback: (settings: AppSettings) => void) => {
    if (channel !== 'epoch:settingsChanged') throw new Error(`Unexpected IPC event: ${channel}`);
    changed = callback;
    return () => (changed = null);
  },
});

beforeEach(() => {
  // A day in daylight saving time in Chicago, so each label is known.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T15:00:00Z'));
  stored = { displayZone: 'UTC', backupsFolder: null };
  changed = null;
  readError = null;
  readGate = null;
  setDisplayZone.mockClear();
  // As at start-up: nothing loaded until SettingsGate loads it.
  useSettingsStore.setState({ settings: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const app = () =>
  render(
    <SettingsGate>
      <SettingsView />
      <p data-testid="elsewhere">
        <DateTime value="2026-11-01T06:30:00Z" />
      </p>
    </SettingsGate>
  );

describe('the time zone setting', () => {
  it('names each zone as the board does: UTC as the default, a named zone with its label now', () => {
    const now = new Date('2026-10-20T15:00:00Z');
    assert.equal(zoneOption('UTC', now), 'UTC (default)');
    assert.equal(zoneOption('America/Chicago', now), 'America/Chicago (CDT, UTC−05:00)');
    assert.equal(zoneOption('Asia/Kolkata', now), 'Asia/Kolkata (UTC+05:30)');
  });

  it('shows nothing until the settings are loaded, then times in the zone they hold', async () => {
    stored = { displayZone: 'America/Chicago', backupsFolder: null };
    app();
    assert.equal(screen.queryByTestId('elsewhere'), null, 'no time is shown before the zone is known');
    const elsewhere = await screen.findByTestId('elsewhere');
    assert.equal(elsewhere.textContent, '2026-11-01 01:30:00 CDT, UTC−05:00');
  });

  it('changes every time shown when a zone is chosen, and each still says its zone', async () => {
    app();
    const select = await screen.findByRole('combobox', { name: 'Time zone' });
    assert.equal(screen.getByTestId('elsewhere').textContent, '2026-11-01 06:30:00 UTC');
    assert.equal((select as HTMLSelectElement).value, 'UTC');
    assert.ok(screen.getByRole('option', { name: 'UTC (default)' }));
    assert.ok(screen.getByText(/Evidence times are stored in UTC\. This changes only how times are shown/));

    await act(async () => fireEvent.change(select, { target: { value: 'America/Chicago' } }));
    assert.deepEqual(setDisplayZone.mock.calls, [['America/Chicago']]);
    assert.equal(screen.getByTestId('elsewhere').textContent, '2026-11-01 01:30:00 CDT, UTC−05:00');
    // The preview is the time now, in the zone chosen.
    assert.ok(screen.getByText('2026-10-20 10:00:00'));

    await act(async () => fireEvent.change(select, { target: { value: 'Asia/Kolkata' } }));
    assert.equal(screen.getByTestId('elsewhere').textContent, '2026-11-01 12:00:00 UTC+05:30');
  });

  it('follows a zone chosen in another window', async () => {
    app();
    await screen.findByTestId('elsewhere');
    await act(async () => changed!({ displayZone: 'Asia/Kolkata', backupsFolder: null }));
    assert.equal(screen.getByTestId('elsewhere').textContent, '2026-11-01 12:00:00 UTC+05:30');
  });

  it('keeps a change from another window that arrives before its first read answers (CodeRabbit, PR #138)', async () => {
    let answer!: () => void;
    readGate = new Promise((resolve) => (answer = resolve));
    app();
    // The read has taken the file as UTC; then another window chooses Kolkata's zone.
    await act(async () => changed!({ displayZone: 'Asia/Calcutta', backupsFolder: null }));
    await act(async () => answer());
    assert.equal(screen.getByTestId('elsewhere').textContent, '2026-11-01 12:00:00 UTC+05:30');
  });

  it('says why when a zone could not be saved, and keeps the zone it had', async () => {
    setDisplayZone.mockRejectedValueOnce(new Error('the disk is full'));
    app();
    const select = await screen.findByRole('combobox', { name: 'Time zone' });
    await act(async () => fireEvent.change(select, { target: { value: 'America/Chicago' } }));
    assert.match(screen.getByRole('alert').textContent ?? '', /The time zone could not be saved: the disk is full/);
    assert.equal(screen.getByTestId('elsewhere').textContent, '2026-11-01 06:30:00 UTC');
  });

  it('says the settings could not be read, naming why, rather than showing times in a guessed zone', async () => {
    readError = new Error('/home/examiner/.config/Epoch/settings.json is not valid JSON');
    app();
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent ?? '', /Epoch's settings could not be read/);
    assert.match(alert.textContent ?? '', /settings\.json is not valid JSON/);
    assert.equal(screen.queryByTestId('elsewhere'), null);
  });
});
