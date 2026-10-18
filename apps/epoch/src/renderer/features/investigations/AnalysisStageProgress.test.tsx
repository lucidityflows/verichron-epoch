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

  it('shows the stage and updates its elapsed time', () => {
    render(<AnalysisStageProgress stage={{ name: 'ileapp_bridge', startedAt: 0 }} />);
    expect(screen.getByText('Stage: ileapp bridge · 10.0 s elapsed')).toBeTruthy();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('Stage: ileapp bridge · 11.0 s elapsed')).toBeTruthy();
  });
});
