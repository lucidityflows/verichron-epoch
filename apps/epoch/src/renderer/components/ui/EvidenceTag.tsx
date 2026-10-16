import React from 'react';
import type { PipelineRunRow } from '@verichron/etl-db-reader';
import { Badge } from './Badge';
import { Tooltip, TooltipTrigger, TooltipContent } from './Tooltip';

interface EvidenceTagProps {
  run: PipelineRunRow;
}

/** Labels for run_completeness states (EPOCH-404); the state is never derived here. */
const RUN_STATE_LABEL: Record<PipelineRunRow['state'], string> = {
  running: 'in progress',
  incomplete: 'incomplete',
  complete: 'complete',
};

export function EvidenceTag({ run }: EvidenceTagProps) {
  return (
    <div className="flex items-center gap-4 px-6 py-3 shadow-elevation-1 text-xs">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="font-mono text-accent cursor-default">{run.run_id.slice(0, 8)}</span>
        </TooltipTrigger>
        <TooltipContent>{run.run_id}</TooltipContent>
      </Tooltip>
      <span className="font-mono text-muted-foreground">{run.backup_source.split('/').pop()}</span>
      <span className="font-mono text-muted-foreground">{new Date(run.started_at).toLocaleString()}</span>
      <Badge variant={run.state}>{RUN_STATE_LABEL[run.state]}</Badge>
    </div>
  );
}
