import React, { useCallback, useEffect } from 'react';
import type { PipelineRunRow } from '@verichron/etl-db-reader';
import { Sidebar, type Section } from './components/layout/Sidebar';
import { WorkspaceView } from './views/WorkspaceView';
import { RunsView } from './views/RunsView';
import { RecordsView } from './views/RecordsView';
import { IocsView } from './views/IocsView';
import { ReportsView } from './views/ReportsView';
import { EvidenceTag } from './components/ui/EvidenceTag';
import { ActivityLogDock } from './features/activityLog/ActivityLogDock';
import { TooltipProvider } from './components/ui/Tooltip';
import { useEpochStore } from './store/useEpochStore';
import { runsApi } from './api/runs';

export const App: React.FC = () => {
  const {
    section,
    runs,
    selectedRun,
    stages,
    records,
    recordsTotal,
    recordsLoaded,
    sourceTypeFilter,
    loading,
    error,
    dbStatus,
    setSection,
    setRuns,
    setSelectedRun,
    setStages,
    setRecords,
    setRecordsLoaded,
    setSourceTypeFilter,
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

  const loadRecords = async (run: PipelineRunRow) => {
    if (!run.evidence_id) {
      // Nothing to read; RecordsView says the evidence isn't registered.
      setRecords([], 0);
      setRecordsLoaded(true);
      return;
    }
    try {
      // First page only, with the true total (R25). RecordsView says when it
      // is showing less than everything; the paged, server-filtered grid is
      // EPOCH-411.
      const page = await runsApi.getForensicRecords(run.run_id);
      setRecords(page.rows, page.total);
      setRecordsLoaded(true);
      setDbStatus('connected');
    } catch (err) {
      console.error('Failed to load records:', err);
      setDbStatus('error');
    }
  };

  const handleSectionSelect = (next: Section) => {
    setSection(next);
    if (next === 'records' && selectedRun && !recordsLoaded) {
      loadRecords(selectedRun);
    }
  };

  const availableSourceTypes = Array.from(new Set(records.map((r) => r.source_type))).sort();
  const visibleRecords = sourceTypeFilter ? records.filter((r) => r.source_type === sourceTypeFilter) : records;

  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background text-foreground">
        <Sidebar active={section} onSelect={handleSectionSelect} dbStatus={dbStatus} />

        <div className="flex-1 flex flex-col min-w-0">
          {/* Nothing is selected on New Investigation (EPOCH-558). U4 replaces the strip with the
              selected investigation's own card. */}
          {selectedRun && section !== 'workspace' && <EvidenceTag run={selectedRun} />}

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
              <RunsView
                runs={runs}
                loading={loading}
                error={error}
                selectedRun={selectedRun}
                stages={stages}
                onSelectRun={selectRun}
                onRefreshStages={refreshStages}
                onRefreshRun={refreshRun}
              />
            )}

            {section === 'records' && (
              <RecordsView
                selectedRun={!!selectedRun}
                runId={selectedRun?.run_id ?? null}
                onRerunFinished={() => {
                  if (!selectedRun) return;
                  refreshRun(selectedRun.run_id);
                  loadRecords(selectedRun);
                }}
                records={visibleRecords}
                loadedCount={records.length}
                totalCount={recordsTotal}
                evidenceRegistered={!!selectedRun?.evidence_id}
                availableSourceTypes={availableSourceTypes}
                sourceTypeFilter={sourceTypeFilter}
                onFilterChange={setSourceTypeFilter}
              />
            )}

            {section === 'iocs' && <IocsView selectedRun={selectedRun} />}

            {section === 'reports' && <ReportsView selectedRun={selectedRun} />}
          </div>

          {/* EPOCH-570: the Activity Log, docked below the page, never inside it. U4 adds it to Investigations. */}
          {section === 'workspace' && <ActivityLogDock />}
        </div>
      </div>
    </TooltipProvider>
  );
};
