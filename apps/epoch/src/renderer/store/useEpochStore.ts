import { create } from 'zustand';
import type { PipelineRunRow, StageStatusRow, ForensicRecordRow } from '@verichron/etl-db-reader';
import type { Section } from '../components/layout/Sidebar';
import type { ReportResult } from '../../shared/types/window';

interface EpochState {
  section: Section;
  runs: PipelineRunRow[];
  selectedRun: PipelineRunRow | null;
  stages: StageStatusRow[];
  records: ForensicRecordRow[];
  /** Every record for the run's evidence; `records` may be only the first page (R25). */
  recordsTotal: number;
  recordsLoaded: boolean;
  sourceTypeFilter: string | null;
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
  setRecords: (records: ForensicRecordRow[], total: number) => void;
  setRecordsLoaded: (loaded: boolean) => void;
  setSourceTypeFilter: (filter: string | null) => void;
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
  records: [],
  recordsTotal: 0,
  recordsLoaded: false,
  sourceTypeFilter: null,
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
  setRecords: (records, recordsTotal) => set({ records, recordsTotal }),
  setRecordsLoaded: (recordsLoaded) => set({ recordsLoaded }),
  setSourceTypeFilter: (sourceTypeFilter) => set({ sourceTypeFilter }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setDbStatus: (dbStatus) => set({ dbStatus }),
  setReport: (report) => set({ report }),
  setReportLoaded: (reportLoaded) => set({ reportLoaded }),
  setReportLoadError: (reportLoadError) => set({ reportLoadError }),
  setReportLoading: (reportLoading) => set({ reportLoading }),
  resetRunState: () =>
    set({
      records: [],
      recordsTotal: 0,
      recordsLoaded: false,
      sourceTypeFilter: null,
      report: null,
      reportLoaded: false,
      reportLoadError: null,
    }),
}));
