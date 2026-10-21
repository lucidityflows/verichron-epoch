import { create } from 'zustand';
import type { PipelineRunRow, StageStatusRow } from '@verichron/etl-db-reader';
import type { Section } from '../components/layout/Sidebar';
import type { ReportResult } from '../../shared/types/window';

interface EpochState {
  section: Section;
  runs: PipelineRunRow[];
  selectedRun: PipelineRunRow | null;
  stages: StageStatusRow[];
  loading: boolean;
  error: string | null;
  dbStatus: 'connected' | 'error' | 'unknown';
  report: ReportResult | null;
  reportLoaded: boolean;
  reportLoadError: string | null;
  reportLoading: boolean;

  // Actions
  setSection: (section: Section) => void;
  setRuns: (runs: PipelineRunRow[]) => void;
  setSelectedRun: (run: PipelineRunRow | null) => void;
  setStages: (stages: StageStatusRow[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setDbStatus: (status: 'connected' | 'error' | 'unknown') => void;
  setReport: (report: ReportResult | null) => void;
  setReportLoaded: (loaded: boolean) => void;
  setReportLoadError: (error: string | null) => void;
  setReportLoading: (loading: boolean) => void;
  resetRunState: () => void;
}

export const useEpochStore = create<EpochState>((set) => ({
  section: 'runs',
  runs: [],
  selectedRun: null,
  stages: [],
  loading: true,
  error: null,
  dbStatus: 'unknown',
  report: null,
  reportLoaded: false,
  reportLoadError: null,
  reportLoading: false,

  setSection: (section) => set({ section }),
  setRuns: (runs) => set({ runs }),
  setSelectedRun: (selectedRun) => set({ selectedRun }),
  setStages: (stages) => set({ stages }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setDbStatus: (dbStatus) => set({ dbStatus }),
  setReport: (report) => set({ report }),
  setReportLoaded: (reportLoaded) => set({ reportLoaded }),
  setReportLoadError: (reportLoadError) => set({ reportLoadError }),
  setReportLoading: (reportLoading) => set({ reportLoading }),
  resetRunState: () =>
    set({
      report: null,
      reportLoaded: false,
      reportLoadError: null,
    }),
}));
