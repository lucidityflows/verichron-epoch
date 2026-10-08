import React, { useCallback, useEffect } from 'react';
import type { PipelineRunRow } from '@verichron/etl-db-reader';
import { Sidebar, type Section } from './components/layout/Sidebar';
import { WorkspaceView } from './views/WorkspaceView';
import { RunsView } from './views/RunsView';
import { RecordsView } from './views/RecordsView';
import { IocsView } from './views/IocsView';
import { ReportsView } from './views/ReportsView';
import { EvidenceTag } from './components/ui/EvidenceTag';
import { TooltipProvider } from './components/ui/Tooltip';
import { useEpochStore } from './store/useEpochStore';
import { runsApi } from './api/runs';

function runPhase(run: PipelineRunRow): 'in_progress' | 'finished' {
  return run.finished_at ? 'finished' : 'in_progress';
}

const IOC_SOURCE_TYPES = ['mvt_ioc_detection', 'timestamp_anomaly'] as const;

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

  const refreshRun = useCallback(async (runId: string) => {
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
  }, [setDbStatus, setRuns, setSelectedRun]);

  const loadRecords = async (run: PipelineRunRow) => {
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
    if ((next === 'records' || next === 'iocs') && selectedRun && !recordsLoaded) {
      loadRecords(selectedRun);
    }
  };

  const nonIocRecords = records.filter((r) => !(IOC_SOURCE_TYPES as readonly string[]).includes(r.source_type));
  const availableSourceTypes = Array.from(new Set(nonIocRecords.map((r) => r.source_type))).sort();
  const visibleRecords = sourceTypeFilter
    ? nonIocRecords.filter((r) => r.source_type === sourceTypeFilter)
    : nonIocRecords;

  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background text-foreground">
        <Sidebar active={section} onSelect={handleSectionSelect} dbStatus={dbStatus} />

        <div className="flex-1 flex flex-col min-w-0">
          {selectedRun && <EvidenceTag run={selectedRun} phase={runPhase(selectedRun)} />}

          <div className="flex-1 overflow-auto p-8">
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
                records={visibleRecords}
                loadedCount={records.length}
                totalCount={recordsTotal}
                availableSourceTypes={availableSourceTypes}
                sourceTypeFilter={sourceTypeFilter}
                onFilterChange={setSourceTypeFilter}
              />
            )}

            {section === 'iocs' && (
              <IocsView selectedRun={selectedRun} />
            )}

            {section === 'reports' && (
              <ReportsView 
                selectedRun={selectedRun} 
              />
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};