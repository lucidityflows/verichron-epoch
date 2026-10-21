import React, { useCallback, useEffect, useState } from 'react';
import type { PipelineRunRow } from '@verichron/etl-db-reader';
import { Sidebar, type Section } from './components/layout/Sidebar';
import { WorkspaceView } from './views/WorkspaceView';
import { InvestigationsView } from './views/InvestigationsView';
import { RecordsView } from './views/RecordsView';
import { TimelineView } from './views/TimelineView';
import type { RecordFilters } from './features/records/useRecords';
import { IocsView } from './views/IocsView';
import { ReportsView } from './views/ReportsView';
import { SettingsView } from './views/SettingsView';
import { ActivityLogDock } from './features/activityLog/ActivityLogDock';
import { TooltipProvider } from './components/ui/Tooltip';
import { useEpochStore } from './store/useEpochStore';
import { runsApi } from './api/runs';
import { analysisName } from './features/investigations/investigations';

export const App: React.FC = () => {
  const {
    section,
    runs,
    selectedRun,
    stages,
    loading,
    error,
    dbStatus,
    setSection,
    setRuns,
    setSelectedRun,
    setStages,
    setLoading,
    setError,
    setDbStatus,
    resetRunState,
  } = useEpochStore();

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await runsApi.getPipelineRuns();
      setRuns(data);
      setDbStatus('connected');
    } catch (err) {
      console.error('Failed to load runs:', err);
      setError(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setDbStatus('error');
    } finally {
      setLoading(false);
    }
  }, [setLoading, setError, setRuns, setDbStatus]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const selectRun = async (run: PipelineRunRow) => {
    setSelectedRun(run);
    resetRunState();
    try {
      const data = await runsApi.getStageStatus(run.run_id);
      setStages(data);
      setDbStatus('connected');
    } catch (err) {
      console.error('Failed to load stages:', err);
      setDbStatus('error');
    }
  };

  const refreshStages = async (runId: string) => {
    try {
      const data = await runsApi.getStageStatus(runId);
      setStages(data);
      setDbStatus('connected');
    } catch (err) {
      console.error('Failed to refresh stages:', err);
      setDbStatus('error');
    }
  };

  const refreshRun = useCallback(
    async (runId: string) => {
      try {
        const data = await runsApi.getPipelineRuns();
        setRuns(data);
        const refreshedRun = data.find((run) => run.run_id === runId);
        const currentSelectedRun = useEpochStore.getState().selectedRun;
        if (refreshedRun && currentSelectedRun?.run_id === runId) {
          setSelectedRun(refreshedRun);
        }
        setDbStatus('connected');
      } catch (err) {
        console.error('Failed to refresh run:', err);
        setDbStatus('error');
      }
    },
    [setDbStatus, setRuns, setSelectedRun]
  );

  // Forensic Records reads its own pages and counts; a finished rerun reads them again.
  const [recordsVersion, setRecordsVersion] = useState(0);

  // A record Indicator Matches asked Forensic Records to open; it is cleared once opened.
  const [recordToOpen, setRecordToOpen] = useState<string | null>(null);
  const recordOpened = useCallback(() => setRecordToOpen(null), []);
  // Filters the Timeline asked Forensic Records to open with (EPOCH-580); cleared once applied.
  const [recordsToShow, setRecordsToShow] = useState<RecordFilters | null>(null);
  const filtersShown = useCallback(() => setRecordsToShow(null), []);
  // A range the Timeline was asked to show (a record's context window, EPOCH-522); cleared once shown.
  const [timelineToShow, setTimelineToShow] = useState<[number, number] | null>(null);
  const timelineShown = useCallback(() => setTimelineToShow(null), []);
  const showOnTimeline = useCallback(
    (range: [number, number]) => {
      setTimelineToShow(range);
      setSection('timeline');
    },
    [setSection]
  );

  const handleSectionSelect = (next: Section) => setSection(next);

  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background text-foreground">
        <Sidebar active={section} onSelect={handleSectionSelect} dbStatus={dbStatus} />

        <div className="flex-1 flex flex-col min-w-0">
          {/* The one place a view's gutter is set (EPOCH-464, DESIGN.md §6). */}
          <div className="flex-1 min-h-0 overflow-auto p-8 flex flex-col">
            {section === 'workspace' && (
              <WorkspaceView
                onAnalysisComplete={() => {
                  setSection('runs');
                  loadRuns();
                }}
              />
            )}

            {section === 'runs' && (
              <InvestigationsView
                runs={runs}
                loading={loading}
                error={error}
                selectedRun={selectedRun}
                stages={stages}
                onSelectRun={selectRun}
                onViewReport={() => handleSectionSelect('reports')}
                onRefreshStages={refreshStages}
                onRefreshRun={refreshRun}
              />
            )}

            {section === 'timeline' && (
              <TimelineView
                selectedRun={selectedRun}
                onOpenRecords={(filters) => {
                  setRecordsToShow(filters);
                  setSection('records');
                }}
                onOpenRecord={(recordId) => {
                  setRecordToOpen(recordId);
                  setSection('records');
                }}
                openRange={timelineToShow}
                onRangeOpened={timelineShown}
              />
            )}

            {section === 'records' && (
              <RecordsView
                key={recordsVersion}
                selectedRun={!!selectedRun}
                runId={selectedRun?.run_id ?? null}
                analysisName={analysisName(selectedRun)}
                evidenceRegistered={!!selectedRun?.evidence_id}
                onRerunFinished={() => {
                  if (!selectedRun) return;
                  refreshRun(selectedRun.run_id);
                  setRecordsVersion((v) => v + 1);
                }}
                onOpenInvestigations={() => setSection('runs')}
                onOpenIndicatorMatches={() => setSection('iocs')}
                openRecordId={recordToOpen}
                onRecordOpened={recordOpened}
                openFilters={recordsToShow}
                onFiltersOpened={filtersShown}
                onShowOnTimeline={showOnTimeline}
              />
            )}

            {section === 'iocs' && (
              <IocsView
                selectedRun={selectedRun}
                onOpenRecord={(recordId) => {
                  setRecordToOpen(recordId);
                  setSection('records');
                }}
                onOpenRecords={(filters) => {
                  setRecordsToShow(filters);
                  setSection('records');
                }}
                onCheckFinished={loadRuns}
              />
            )}

            {section === 'reports' && <ReportsView selectedRun={selectedRun} stages={stages} />}

            {section === 'settings' && <SettingsView />}
          </div>

          {/* EPOCH-570: the Activity Log, docked below the page, never inside it; on Investigations too (U4b). */}
          {(section === 'workspace' || section === 'runs') && <ActivityLogDock />}
        </div>
      </div>
    </TooltipProvider>
  );
};
