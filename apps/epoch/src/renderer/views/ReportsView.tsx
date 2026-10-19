import React, { useState, useEffect } from 'react';
import { FileQuestion, FileText, MousePointerClick } from 'lucide-react';
import type { PipelineRunRow } from '@verichron/etl-db-reader';
import type { ReportResult } from '../../shared/types/window';
import { Button } from '../components/ui/Button';
import { reportsApi } from '../api/reports';
import { ViewLayout } from '../components/layout/ViewLayout';
import { EmptyState } from '../components/ui/EmptyState';
import { analysisName } from '../features/investigations/investigations';

interface ReportsViewProps {
  selectedRun: PipelineRunRow | null;
}

export const ReportsView: React.FC<ReportsViewProps> = ({ selectedRun }) => {
  const [report, setReport] = useState<ReportResult | null>(null);
  const [reportLoadError, setReportLoadError] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  const loadReport = async (run: PipelineRunRow) => {
    setReportLoading(true);
    setReportLoadError(null);
    try {
      const result = await reportsApi.getReport(run.run_id);
      setReport(result);
    } catch (err) {
      console.error('Failed to load report:', err);
      setReportLoadError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setReportLoading(false);
    }
  };

  useEffect(() => {
    if (selectedRun) {
      loadReport(selectedRun);
    } else {
      setReport(null);
    }
  }, [selectedRun]);

  const openReportFile = async () => {
    if (!selectedRun) return;
    const opened = await reportsApi.openReport(selectedRun.run_id);
    if (!opened) console.error('Failed to open report in default app');
  };

  return (
    <ViewLayout
      section="reports"
      title="Reports"
      description="The investigation report for the selected investigation."
      context={analysisName(selectedRun)}
    >
      {!selectedRun ? (
        <EmptyState
          icon={MousePointerClick}
          title="No investigation selected"
          detail="Select an investigation in Investigations to see its report."
        />
      ) : reportLoadError ? (
        // §1 state-color banner rule: shadow-elevation-1 + state-color border together, never border alone.
        <div className="text-warning bg-warning/10 shadow-elevation-1 border border-warning/30 rounded-lg p-4 text-data">
          Error: {reportLoadError}
        </div>
      ) : reportLoading || !report ? (
        <EmptyState loading title="Loading the report…" />
      ) : report.status === 'no-report-path' ? (
        <EmptyState
          icon={FileQuestion}
          title="Report location unknown"
          detail="This run has no registered evidence location (it predates evidence registration), so its report can't be located."
        />
      ) : report.status === 'not-found' ? (
        <EmptyState icon={FileText} title="No report generated yet" detail={<>Expected at {report.path}</>} />
      ) : (
        <div>
          <div className="flex items-center justify-between mb-4">
            <span className="font-mono text-data text-muted-foreground">{report.path}</span>
            {/* §1: a bordered <button> here was the wrong tool for a panel-adjacent
                control -- routed through the shared elevation-based Button primitive
                instead, which also brings text-label for free (§2). */}
            <Button variant="outline" size="sm" onClick={openReportFile}>
              Open in Default App
            </Button>
          </div>
          {/* §1: was bg-surface + flat border -- panel containers use elevation, not
              border, for background separation. */}
          <pre className="card rounded-lg p-5 text-data font-mono whitespace-pre-wrap overflow-auto max-h-[calc(100vh-16rem)]">
            {report.content}
          </pre>
        </div>
      )}
    </ViewLayout>
  );
};
