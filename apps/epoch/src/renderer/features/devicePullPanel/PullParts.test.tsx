import assert from 'node:assert/strict';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type { DeviceInfo, PullStepTimes } from '../../../shared/types/tools';
import { DeviceOption, PulledCard, PullingCard, formatTook } from './PullParts';

afterEach(cleanup);

const IPHONE: DeviceInfo = {
  id: '00008140-0000000000000000',
  name: "Alex's iPhone",
  model: 'iPhone17,5',
  osVersion: '26.6.1',
};

/** The window's height, as the panel's media query reads it. */
function windowIsShort(short: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: short,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

beforeEach(() => windowIsShort(false));

const running: PullStepTimes = {
  startedAt: { check: Date.now() - 60_000, approve: Date.now() - 50_000, copy: Date.now() - 20_000 },
  endedAt: null,
  failed: false,
};

const stats = {
  startedAt: Date.now() - 50_000,
  receivedBytes: 31.2e9,
  lastDataAt: Date.now(),
  percent: 53,
  estimatedBytes: 58.4e9,
};

describe('the iPhone pull panel (EPOCH-554, board "iPhone Pull Flow")', () => {
  it('names a device by its model and iOS version, with a quiet Select', () => {
    render(<DeviceOption device={IPHONE} selected={false} disabled={false} onChoose={() => undefined} />);
    assert.ok(screen.getByText('iPhone 17,5 · iOS 26.6.1'));
    assert.ok(screen.getByText("Connected by cable · Alex's iPhone"));
    assert.equal(screen.getByText('Select').className.includes('bg-accent'), false);
    assert.equal(screen.queryByText(IPHONE.id), null);
  });

  it('puts progress and Cancel first, then the steps with their durations', () => {
    let cancelled = false;
    render(
      <PullingCard
        device={IPHONE}
        destShown="~/Epoch Backups"
        times={running}
        stats={stats}
        cancelling={false}
        onCancel={() => {
          cancelled = true;
        }}
      />
    );
    assert.ok(screen.getByRole('heading', { name: 'Pulling iPhone 17,5 · iOS 26.6.1' }));
    assert.ok(screen.getByText('Copy files · 31.2 GB of about 58.4 GB'));
    assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), '53');
    const steps = screen.getByRole('list', { name: 'What the pull is doing' });
    assert.equal(steps.querySelectorAll('li').length, 5);
    assert.ok(screen.getByText('Copy files').closest('li')?.getAttribute('aria-current'));
    fireEvent.click(screen.getByRole('button', { name: /Cancel Pull/ }));
    assert.equal(cancelled, true);
  });

  it('folds the steps into one line in a short window, and opens them on request', () => {
    windowIsShort(true);
    render(
      <PullingCard
        device={IPHONE}
        destShown={null}
        times={running}
        stats={stats}
        cancelling={false}
        onCancel={() => undefined}
      />
    );
    assert.equal(screen.queryByRole('list', { name: 'What the pull is doing' }), null);
    assert.ok(screen.getByText('Step 3 of 5'));
    fireEvent.click(screen.getByRole('button', { name: 'Show Steps' }));
    assert.ok(screen.getByRole('list', { name: 'What the pull is doing' }));
  });

  it('states what was verified, by what the code checks', () => {
    let continued = false;
    const ended: PullStepTimes = { startedAt: { check: 1_000 }, endedAt: 1_000 + 1_572_000, failed: false };
    render(
      <PulledCard
        device={IPHONE}
        times={ended}
        stats={{ ...stats, receivedBytes: 58.4e9 }}
        crashReports={{ outcome: 'copied', files: 3, backupDir: '/b' }}
        savedShown="~/Epoch Backups/iPhone17,5"
        onContinue={() => {
          continued = true;
        }}
      />
    );
    assert.ok(screen.getByText('Status: finished · Manifest present'));
    assert.ok(screen.getByText('3 copied'));
    assert.ok(screen.getByText(/pull took 26 m 12 s/));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Prepare Evidence' }));
    assert.equal(continued, true);
  });

  it('writes how long a pull took', () => {
    assert.equal(formatTook(45_000), '45 s');
    assert.equal(formatTook(1_572_000), '26 m 12 s');
    assert.equal(formatTook(3_840_000), '1 h 4 m');
  });
});
