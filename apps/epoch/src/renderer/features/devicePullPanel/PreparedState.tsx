import { CheckCircle2 } from 'lucide-react';

import { formatDateTime } from '../../../shared/time';
import type { PreparedBackup } from '../../../shared/types/window';

const CHIP = 'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-label whitespace-nowrap shrink-0';

/** The backup's state in the workspace, as a chip in its role colour (DESIGN.md §9, board 5). */
export function PreparedState({ prepared }: { prepared?: PreparedBackup }) {
  if (!prepared) return <span className={`${CHIP} bg-muted-foreground/14 text-foreground`}>Not prepared</span>;
  const when = formatDateTime(prepared.preparedAt);
  if (prepared.state === 'partial') {
    // Its reason is written out beneath the backup's facts, not on hover (DESIGN.md §9).
    return <span className={`${CHIP} bg-warning/10 text-warning`}>Partly prepared · prepare again</span>;
  }
  return (
    <span className={`${CHIP} bg-success/10 text-success`}>
      <CheckCircle2 size="0.875rem" /> Prepared · {when}
    </span>
  );
}
