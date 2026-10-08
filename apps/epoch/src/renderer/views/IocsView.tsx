import React, { useEffect, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { PipelineRunRow, CorrelationPivotRow, CorrelatedContextRow } from '@verichron/etl-db-reader';
import { CORRELATION_WINDOW_MINUTES } from '@verichron/etl-db-reader';
import { Badge } from '../components/ui/Badge';
import { runsApi } from '../api/runs';

const IOC_SOURCE_TYPES = ['mvt_ioc_detection', 'timestamp_anomaly'] as const;
type IocSourceType = (typeof IOC_SOURCE_TYPES)[number];

function isIocSourceType(sourceType: string): sourceType is IocSourceType {
  return (IOC_SOURCE_TYPES as readonly string[]).includes(sourceType);
}

function formatDelta(seconds: unknown): string {
  if (typeof seconds !== 'number') return '—';
  const days = Math.floor(Math.abs(seconds) / 86400);
  const hours = Math.floor((Math.abs(seconds) % 86400) / 3600);
  return `${seconds < 0 ? '-' : '+'}${days}d ${hours}h`;
}

interface IocsViewProps {
  selectedRun: PipelineRunRow | null;
}

/**
 * Loads its own complete pivot list. It used to filter the Records page's
 * loaded rows, which were capped at 500: an indicator past row 500 was
 * silently dropped, and a run whose only detections were late in the
 * timeline showed "no indicator matches" -- a false negative.
 */
export const IocsView: React.FC<IocsViewProps> = ({ selectedRun }) => {
  const [pivots, setPivots] = useState<CorrelationPivotRow[]>([]);
  const [pivotsLoaded, setPivotsLoaded] = useState(false);
  const [pivotsError, setPivotsError] = useState<string | null>(null);
  const [expandedPivotId, setExpandedPivotId] = useState<string | null>(null);
  const [correlatedContext, setCorrelatedContext] = useState<Record<string, CorrelatedContextRow[]>>({});
  const [correlatedLoading, setCorrelatedLoading] = useState<string | null>(null);
  const [correlatedError, setCorrelatedError] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setPivots([]);
    setPivotsLoaded(false);
    setPivotsError(null);
    if (!selectedRun) return;
    runsApi
      .getCorrelationPivots(selectedRun.run_id)
      .then((rows) => {
        if (!cancelled) {
          setPivots(rows);
          setPivotsLoaded(true);
        }
      })
      .catch((err) => {
        if (!cancelled) setPivotsError(err instanceof Error ? err.message : 'Unknown error');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRun]);

  const toggleCorrelatedContext = async (pivot: CorrelationPivotRow) => {
    if (expandedPivotId === pivot.id) {
      setExpandedPivotId(null);
      return;
    }
    setExpandedPivotId(pivot.id);
    
    if (correlatedContext[pivot.id] || !selectedRun || !pivot.event_time) return;
    
    setCorrelatedLoading(pivot.id);
    try {
      const data = await runsApi.getCorrelatedContext(selectedRun.run_id, pivot.event_time, pivot.id);
      setCorrelatedContext((prev) => ({ ...prev, [pivot.id]: data }));
    } catch (err) {
      console.error('Failed to load correlated context:', err);
      setCorrelatedError((prev) => ({
        ...prev,
        [pivot.id]: err instanceof Error ? err.message : 'Unknown error',
      }));
    } finally {
      setCorrelatedLoading(null);
    }
  };

  const iocRecords = pivots.filter((r) => isIocSourceType(r.source_type));

  return (
    <div>
      <h2 className="font-display text-display text-accent mb-6">Indicator Matches</h2>
      {!selectedRun ? (
        <p className="text-muted-foreground text-data">Select an investigation first.</p>
      ) : pivotsError ? (
        <p className="text-muted-foreground text-data">Could not load indicator matches: {pivotsError}</p>
      ) : !pivotsLoaded ? (
        <p className="text-muted-foreground text-data">Loading indicator matches…</p>
      ) : iocRecords.length === 0 ? (
        <p className="text-muted-foreground text-data">
          No indicator matches or timing anomalies were found for this investigation.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {iocRecords.map((rec) => {
            const isDetection = rec.source_type === 'mvt_ioc_detection';
            const matched = isDetection && rec.fields.matched_indicator != null;
            const expandable = rec.event_time != null;
            const expanded = expandedPivotId === rec.id;
            const contextRows = correlatedContext[rec.id];
            const contextError = correlatedError[rec.id];

            return (
              <div
                key={rec.id}
                className={`rounded-lg ${
                  matched ? 'bg-flag/10 shadow-elevation-1' : 'bg-surface shadow-elevation-1'
                }`}
              >
                <div
                  className={`p-4 ${expandable ? 'cursor-pointer' : ''}`}
                  onClick={() => expandable && toggleCorrelatedContext(rec)}
                >
                  <div className="flex items-center gap-2 mb-3">
                    {expandable &&
                      (expanded ? (
                        <ChevronDown size="0.875rem" className="text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight size="0.875rem" className="text-muted-foreground shrink-0" />
                      ))}
                    <Badge variant={matched ? 'flag' : 'neutral'}>{rec.source_type}</Badge>
                    {rec.event_time && (
                      <span className="font-mono text-data text-muted-foreground">
                        {new Date(rec.event_time).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {isDetection ? (
                    <>
                      <p className="text-data">{String(rec.fields.message ?? '—')}</p>
                      {matched && (
                        <p className="text-data font-mono text-flag mt-2">
                          matched: {String(rec.fields.matched_indicator)}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="text-data">
                        {String(rec.fields.plugin ?? '—')} — {String(rec.fields.description ?? rec.fields.event ?? '—')}
                      </p>
                      <p className="text-data font-mono text-muted-foreground mt-2">
                        {formatDelta(rec.fields.delta_from_backup_seconds)} from backup date
                      </p>
                    </>
                  )}
                </div>
                {expanded && (
                  <div className="shadow-elevation-1/60 p-4">
                    <p className="text-2xs uppercase tracking-wide text-muted-foreground mb-3">
                      Nearby events (±{CORRELATION_WINDOW_MINUTES}m)
                    </p>
                    {contextError ? (
                      <p className="text-data text-flag font-mono">Error: {contextError}</p>
                    ) : correlatedLoading === rec.id ? (
                      <p className="text-data text-muted-foreground">Loading...</p>
                    ) : !contextRows || contextRows.length === 0 ? (
                      <p className="text-data text-muted-foreground">No other events in this window.</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {contextRows.map((ctx) => (
                          <div key={ctx.id} className="flex items-center gap-3 text-data">
                            <Badge variant="neutral">{ctx.source_type}</Badge>
                            <span className="font-mono text-muted-foreground">
                              {ctx.event_time ? new Date(ctx.event_time).toLocaleString() : '—'}
                            </span>
                            {ctx.process_name && (
                              <span className="font-mono text-foreground">{ctx.process_name}</span>
                            )}
                            {ctx.bundle_id && (
                              <span className="font-mono text-muted-foreground">{ctx.bundle_id}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};