import { describe, expect, it } from 'vitest';
import {
  PipelineEvent,
  eventLevel,
  eventMessage,
  type PipelineEventBody,
  type TaskLogEntry,
} from '@verichron/contracts';

import {
  entryTag,
  failureDetails,
  latestLine,
  lineText,
  logCounts,
  logFileText,
  logText,
  visibleEntries,
} from './activityLog';

const TASK = '1f3a9c2e-0000-4000-8000-000000000001';
const AT = '2026-10-18T15:21:03.000Z';
let seq = 0;

function message(level: TaskLogEntry['level'], text: string, label: string | null = null): TaskLogEntry {
  return {
    v: 1,
    task_id: TASK,
    seq: ++seq,
    at: AT,
    clock: 'received',
    level,
    source: 'app',
    label,
    step: null,
    kind: 'message',
    message: text,
  };
}

function event(body: PipelineEventBody, step: string | null = null): TaskLogEntry {
  const parsed = PipelineEvent.parse({ v: 1, at: AT, ...body });
  return {
    v: 1,
    task_id: TASK,
    seq: ++seq,
    at: AT,
    clock: 'source',
    level: eventLevel(parsed),
    source: 'orchestrator',
    label: 'label' in parsed ? (parsed.label ?? null) : null,
    step,
    kind: 'event',
    message: eventMessage(parsed),
    event: parsed,
  };
}

const log = () => {
  seq = 0;
  return [
    message('info', 'Analyze started for 1 backup'),
    message('debug', 'the orchestrator started'),
    event(
      { type: 'stage:log', stage: 'ileapp_bridge', level: 'info', message: '44,619 record(s) written' },
      'ileapp_bridge'
    ),
    event(
      {
        type: 'stage:log',
        stage: 'ileapp_bridge',
        level: 'warn',
        message: 'Calendar Events: 57 times before 2007',
        review: true,
      },
      'ileapp_bridge'
    ),
    event({ type: 'ileapp:module', label: 'BK', index: 1, total: 879, module: 'sms' }, 'ileapp'),
    event({ type: 'ileapp:module', label: 'BK', index: 2, total: 879, module: 'calls' }, 'ileapp'),
    message('warn', 'repair could not recover 1 database', 'BK'),
    message('error', 'Reading device activity with iLEAPP failed: iLEAPP exited with code 1', 'BK'),
  ];
};

describe('the Activity Log views (EPOCH-570)', () => {
  it('Summary: no debug, progress collapsed to its latest line, and tags only on what needs a look', () => {
    const shown = visibleEntries(log(), { view: 'summary', filter: 'all', search: '' });
    expect(shown.map((e) => e.message)).toEqual([
      'Analyze started for 1 backup',
      'Reading device activity: 44,619 record(s) written',
      'Reading device activity: Calendar Events: 57 times before 2007',
      'Reading device activity with iLEAPP: module 2 of 879, calls',
      'repair could not recover 1 database',
      'Reading device activity with iLEAPP failed: iLEAPP exited with code 1',
    ]);
    expect(shown.map((e) => entryTag(e, 'summary'))).toEqual([null, null, 'For review', null, 'Warning', 'Error']);
  });

  it('Full log: every entry, each with its level', () => {
    const shown = visibleEntries(log(), { view: 'full', filter: 'all', search: '' });
    expect(shown).toHaveLength(8);
    expect(shown.map((e) => entryTag(e, 'full'))).toEqual([
      'INFO',
      'DEBUG',
      'INFO',
      'REVIEW',
      'DEBUG',
      'DEBUG',
      'WARN',
      'ERROR',
    ]);
  });

  it('filters by level and searches the message and label', () => {
    expect(visibleEntries(log(), { view: 'full', filter: 'warnings', search: '' })).toHaveLength(2);
    expect(visibleEntries(log(), { view: 'full', filter: 'errors', search: '' })).toHaveLength(1);
    expect(visibleEntries(log(), { view: 'summary', filter: 'all', search: 'calendar' })).toHaveLength(1);
  });

  it('counts errors, warnings and notes for review apart, and the bar shows the latest non-debug line', () => {
    expect(logCounts(log())).toEqual({ errors: 1, warnings: 1, review: 1 });
    expect(latestLine(log())?.level).toBe('error');
  });

  it('writes lines with real spaces, as they show', () => {
    const [started, , written, review] = log();
    expect(lineText(started, 'full', 'UTC')).toBe('15:21:03Z  INFO   Analyze started for 1 backup');
    expect(lineText(review, 'summary', 'UTC')).toBe(
      '15:21:03Z  For review: Reading device activity: Calendar Events: 57 times before 2007'
    );
    expect(logText([started, written], 'summary', 'UTC')).toBe(
      '15:21:03Z  Analyze started for 1 backup\n15:21:03Z  Reading device activity: 44,619 record(s) written'
    );
  });

  it("shows and copies each line's time in the examiner's zone (EPOCH-560)", () => {
    const [started] = log();
    expect(lineText(started, 'full', 'America/Chicago')).toBe('10:21:03 CDT  INFO   Analyze started for 1 backup');
    expect(lineText(started, 'full', 'Asia/Kolkata')).toBe('20:51:03 UTC+05:30  INFO   Analyze started for 1 backup');
    expect(logFileText(log(), 'America/Chicago').split('\n')[1]).toBe('Started unknown; times in America/Chicago');
  });

  it('saves the Full log under a header that says what the task was and how it ended', () => {
    const text = logFileText(log(), 'UTC');
    expect(text.split('\n').slice(0, 3)).toEqual([
      'Task log',
      'Started unknown; times in UTC',
      'Ended: never recorded (the app was closed while it ran)',
    ]);
    expect(text).toContain('DEBUG  the orchestrator started');
  });

  it("copies a failure's details without debug: the step, the evidence, the reason and its entries", () => {
    const details = failureDetails(log(), { label: 'BK', step: 'ileapp', reason: 'iLEAPP exited with code 1' }, 'UTC');
    expect(details.split('\n').slice(0, 3)).toEqual([
      'Backup: BK',
      'Step: ileapp',
      'Reason: iLEAPP exited with code 1',
    ]);
    expect(details).toContain('ERROR  [BK] Reading device activity with iLEAPP failed');
    expect(details).toContain('WARN   [BK] repair could not recover 1 database');
    expect(details).not.toContain('DEBUG');
  });
});
