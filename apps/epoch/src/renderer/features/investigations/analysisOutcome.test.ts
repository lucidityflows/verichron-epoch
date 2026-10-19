import { describe, expect, it } from 'vitest';

import type { BackupAnalysisOutcome } from '../../../shared/types/window';
import { formatClock, outcomeHeadline, outcomeSentence, outcomeTone, stageLine } from './analysisOutcome';

const outcome = (change: Partial<BackupAnalysisOutcome>): BackupAnalysisOutcome => ({
  label: 'A',
  status: 'not-started',
  runId: null,
  runState: null,
  reason: null,
  stopped: null,
  ...change,
});

describe('while Analyze runs (EPOCH-551)', () => {
  it("names the stage, its place in the run, the stage's own count and the time elapsed", () => {
    const stage = {
      name: 'ileapp_bridge',
      title: 'iLEAPP Artifacts',
      startedAt: 0,
      label: 'A',
      index: 2,
      total: 4,
      progress: { index: 211, total: 540 },
    };
    expect(stageLine(stage, 252_000)).toBe(
      'Stage 2 of 4 · iLEAPP Artifacts · 211 of 540 artifact tables · 04:12 elapsed'
    );
    expect(stageLine({ ...stage, name: 'crash', title: 'Crash Reports', index: 1, progress: null }, 5_000)).toBe(
      'Stage 1 of 4 · Crash Reports · 00:05 elapsed'
    );
    expect(formatClock(3_852_000)).toBe('1:04:12');
  });
});

describe('after Analyze ends (EPOCH-550)', () => {
  it('says what an interrupted stage kept, in artifact tables, and that Analyze Again finishes it', () => {
    const stopped = outcome({
      status: 'interrupted',
      stopped: { stage: 'ileapp_bridge', title: 'iLEAPP Artifacts', progress: { index: 211, total: 540 } },
    });
    expect(outcomeSentence(stopped)).toBe(
      'interrupted. iLEAPP Artifacts stopped after reaching 211 of 540 artifact tables. Each table it finished is kept; Analyze Again reads the rest and retries any that failed.'
    );
    expect(outcomeTone(stopped)).toBe('warning');
    expect(
      outcomeSentence(
        outcome({ status: 'interrupted', stopped: { stage: 'crash', title: 'Crash Reports', progress: null } })
      )
    ).toBe('interrupted during Crash Reports. What it finished is kept; Analyze Again finishes it.');
  });

  it('calls a run that a crash or timeout stopped failed, in danger, never interrupted (CodeRabbit, PR #136)', () => {
    const failed = outcome({
      status: 'failed',
      stopped: { stage: 'ileapp_bridge', title: 'iLEAPP Artifacts', progress: { index: 211, total: 540 } },
    });
    expect(outcomeSentence(failed)).toBe(
      'failed. iLEAPP Artifacts stopped after reaching 211 of 540 artifact tables. Each table it finished is kept; Analyze Again reads the rest and retries any that failed.'
    );
    expect(outcomeTone(failed)).toBe('danger');
    expect(outcomeHeadline({ success: false, timedOut: true }, [failed]).text).toBe(
      'Analysis timed out and was stopped. 1 failed.'
    );
  });

  it('gives each of the three outcomes its own words', () => {
    expect(outcomeSentence(outcome({ status: 'finished', runState: 'complete' }))).toBe(
      'finished. Its investigation and report are ready.'
    );
    expect(outcomeSentence(outcome({ status: 'not-started' }))).toBe('not started. Nothing was written for it.');
    expect(outcomeSentence(outcome({ status: 'refused', reason: 'its sidecar is missing' }))).toBe(
      'not started: its sidecar is missing.'
    );
  });

  it('heads a cancel as a stop, in the warning role, with each outcome counted', () => {
    const backups = [
      outcome({ status: 'finished', runState: 'complete' }),
      outcome({ label: 'B', status: 'interrupted' }),
      outcome({ label: 'C', status: 'not-started' }),
    ];
    expect(outcomeHeadline({ success: false, cancelled: true }, backups)).toEqual({
      text: 'Analysis was cancelled. 1 finished, 1 interrupted, 1 not started.',
      tone: 'warning',
    });
  });

  it('counts with the right plurals and spaces', () => {
    const two = [
      outcome({ status: 'finished', runState: 'complete' }),
      outcome({ label: 'B', status: 'finished', runState: 'complete' }),
    ];
    expect(outcomeHeadline({ success: true }, two).text).toBe('2 investigations analyzed. 2 finished.');
    expect(outcomeHeadline({ success: true }, two.slice(0, 1)).text).toBe('1 investigation analyzed. 1 finished.');
    const attention = [outcome({ status: 'finished', runState: 'incomplete' })];
    expect(outcomeHeadline({ success: true }, attention)).toEqual({
      text: 'Analysis finished; 1 backup needs attention. 1 finished.',
      tone: 'danger',
    });
    expect(outcomeHeadline({ success: false, error: 'the database refused the connection.' }, []).text).toBe(
      'Analysis failed: the database refused the connection.'
    );
  });
});
