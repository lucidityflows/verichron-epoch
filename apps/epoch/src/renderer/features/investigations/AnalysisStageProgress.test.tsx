import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisStageProgress } from './AnalysisStageProgress';

describe('AnalysisStageProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the stage by its title, its place and count, and updates its elapsed time (EPOCH-551)', () => {
    render(
      <AnalysisStageProgress
        stage={{
          name: 'ileapp_bridge',
          title: 'iLEAPP Artifacts',
          startedAt: 0,
          label: 'A',
          index: 2,
          total: 4,
          progress: { index: 211, total: 540 },
        }}
      />
    );
    expect(
      screen.getByText('Stage 2 of 4 · iLEAPP Artifacts · 211 of 540 artifact tables · 00:10 elapsed')
    ).toBeTruthy();

    act(() => vi.advanceTimersByTime(1000));
    expect(
      screen.getByText('Stage 2 of 4 · iLEAPP Artifacts · 211 of 540 artifact tables · 00:11 elapsed')
    ).toBeTruthy();
  });
});
