import React, { Suspense, lazy, useMemo, useState, useEffect } from 'react';
import { FileQuestion, FileText, MousePointerClick } from 'lucide-react';
import type { PipelineRunRow, StageStatusRow } from '@verichron/etl-db-reader';
import type { ReportResult } from '../../shared/types/window';
import { Button } from '../components/ui/Button';
import { reportsApi } from '../api/reports';
import { ViewLayout } from '../components/layout/ViewLayout';
import { EmptyState } from '../components/ui/EmptyState';
import { analysisName, warningLines } from '../features/investigations/investigations';
import { NOT_EXAMINED, jumpToSection, notExaminedCount, splitReport } from '../features/reports/reportSections';

// The Markdown renderer adds 157 KB minified (measured 2026-10-19), so it
// loads the first time a report is shown, not at start-up.
const ReportDocument = lazy(() =>
  import('../features/reports/ReportDocument').then((module) => ({ default: module.ReportDocument }))
);

interface ReportsViewProps {
  selectedRun: PipelineRunRow | null;
  /** The selected analysis's stages, as Investigations reads them, for the summary tiles. */
  stages: StageStatusRow[];
}

function Tile({ value, label, onClick }: { value: React.ReactNode; label: string; onClick?: () => void }) {
  const body = (
    <>
      <p className="font-display text-heading text-foreground tabular-nums">{value}</p>
      <p className="text-label text-muted-foreground">{label}</p>
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="text-left bg-surface-raised rounded-lg px-4 py-3 shadow-elevation-1 hover:bg-surface-hover"
    >
      {body}
    </button>
  ) : (
    <div className="bg-surface-raised rounded-lg px-4 py-3 shadow-elevation-1">{body}</div>
  );
}

export const ReportsView: React.FC<ReportsViewProps> = ({ selectedRun, stages }) => {
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

  const shown = selectedRun ? stages.filter((stage) => stage.run_id === selectedRun.run_id) : [];
  const warningCount = shown.reduce(
    (sum, stage) => sum + (stage.status === 'succeeded' ? warningLines(stage.warnings).length : 0),
    0
  );
  // The tile counts the report's own Not Examined list, as its contents entry does (R2).
  const sections = useMemo(() => (report?.status === 'ok' ? splitReport(report.content) : []), [report]);
  const notExaminedItems = notExaminedCount(sections);
  const notExaminedId = sections.find((section) => section.title === NOT_EXAMINED)?.id;

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
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-label text-muted-foreground truncate min-w-0" title={report.path}>
              {report.path}
            </span>
            <Button variant="outline" size="sm" onClick={openReportFile} className="shrink-0">
              Open in Default App
            </Button>
          </div>
          {shown.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Tile
                value={`${shown.filter((stage) => stage.status === 'succeeded').length} of ${shown.length}`}
                label="Stages complete"
              />
              <Tile value={selectedRun.records.toLocaleString('en-US')} label="Records found" />
              <Tile
                value={notExaminedItems ?? '—'}
                label="Not examined · jump to list"
                onClick={notExaminedId ? () => jumpToSection(notExaminedId) : undefined}
              />
              <Tile value={warningCount} label="Warnings" />
            </div>
          )}
          <Suspense fallback={<EmptyState loading title="Loading the report…" />}>
            <ReportDocument markdown={report.content} />
          </Suspense>
        </div>
      )}
    </ViewLayout>
  );
};
