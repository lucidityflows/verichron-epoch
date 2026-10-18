/**
 * The Activity Log drawer and the failure banner (EPOCH-570): what each view
 * shows, the bar's counts, and that a failure names its backup and reason.
 */
import assert from 'node:assert/strict';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TaskLogEntry } from '@verichron/contracts';
import { afterEach, beforeAll, describe, it } from 'vitest';

import { ActivityLog } from './ActivityLog';
import { FailureBanner } from './FailureBanner';

afterEach(cleanup);
beforeAll(() => {
  // jsdom has no layout: give the virtualized list a size so it renders rows.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 220 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
});

const TASK = '1f3a9c2e-0000-4000-8000-000000000001';
let seq = 0;
const at = '2026-10-18T15:21:03.000Z';
const base = { v: 1 as const, task_id: TASK, at, clock: 'received' as const, source: 'app', step: null };

const message = (level: TaskLogEntry['level'], text: string, label: string | null = null): TaskLogEntry => ({
  ...base,
  seq: ++seq,
  level,
  label,
  kind: 'message',
  message: text,
});

const stepError = (label: string, reason: string): TaskLogEntry => ({
  ...base,
  seq: ++seq,
  source: 'processor',
  clock: 'source',
  level: 'error',
  label,
  step: 'ileapp',
  kind: 'event',
  message: `Reading device activity with iLEAPP failed: ${reason}`,
  event: { v: 1, at, type: 'backup:step', label, step: 'ileapp', status: 'error', reason },
});

const review: TaskLogEntry = {
  ...base,
  seq: 90,
  source: 'orchestrator',
  clock: 'source',
  level: 'warn',
  label: null,
  step: 'ileapp_bridge',
  kind: 'event',
  message: 'Reading device activity: Calendar Events: 57 times before 2007',
  event: { v: 1, at, type: 'stage:log', stage: 'ileapp_bridge', level: 'warn', message: 'x', review: true },
};

function entries() {
  seq = 0;
  return [
    message('info', 'Prepare Evidence started for 1 backup'),
    message('debug', 'the processor started'),
    review,
    stepError('BK', 'iLEAPP exited with code 1'),
  ];
}

describe('ActivityLog', () => {
  it('shows the latest meaningful line and the counts on its bar, closed by default', () => {
    render(<ActivityLog entries={entries()} live={false} />);
    const bar = screen.getByRole('button', { name: /Activity Log/ });
    assert.equal(bar.getAttribute('aria-expanded'), 'false');
    assert.match(bar.textContent ?? '', /Reading device activity with iLEAPP failed: iLEAPP exited with code 1/);
    assert.ok(screen.getByText('1 error'));
    assert.ok(screen.getByText('1 for review'));
    assert.equal(screen.queryByRole('log'), null, 'the drawer opens only on a click');
  });

  it('opens to the Summary, which hides debug and tags what needs a look; Full log shows every level', () => {
    render(<ActivityLog entries={entries()} live={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Activity Log/ }));
    const log = screen.getByRole('log');
    assert.doesNotMatch(log.textContent ?? '', /the processor started/);
    assert.match(log.textContent ?? '', /For review: Reading device activity/);
    assert.match(log.textContent ?? '', /Error: \[BK\] Reading device activity with iLEAPP failed/);

    fireEvent.click(screen.getByRole('button', { name: 'Full log' }));
    assert.match(screen.getByRole('log').textContent ?? '', /DEBUG  the processor started/);
  });

  it('filters by level, and says when nothing is at that level', () => {
    render(<ActivityLog entries={[message('info', 'only information')]} live={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Activity Log/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Errors' }));
    assert.ok(screen.getByText('Nothing at this level.'));
  });

  it('says when its log could not be read back, never hiding it', () => {
    render(<ActivityLog entries={[]} live={false} error="The last saved log could not be read: x" />);
    assert.match(screen.getByRole('button', { name: /Activity Log/ }).textContent ?? '', /could not be read/);
  });
});

describe('FailureBanner', () => {
  it("names each failed backup with its failed step's own sentence", () => {
    render(
      <FailureBanner
        failures={[{ label: 'BK', step: 'ileapp', reason: 'iLEAPP exited with code 1' }]}
        entries={entries()}
        prepared={1}
        total={2}
      />
    );
    assert.ok(screen.getByText("1 of 2 backups prepared; 1 couldn't be prepared."));
    assert.ok(screen.getByText(': Reading device activity with iLEAPP failed: iLEAPP exited with code 1'));
    assert.ok(screen.getByRole('button', { name: /Copy Details/ }));
  });
});
