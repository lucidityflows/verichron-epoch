import { XCircle } from 'lucide-react';
import type { TaskLogEntry } from '@verichron/contracts';

import { failureDetails } from '../../../shared/activityLog';
import { CopyButton } from '../../components/ui/CopyButton';

export interface PrepareFailure {
  label: string;
  step: string;
  reason: string;
}

/**
 * Prepare's failures, each naming the backup and why (EPOCH-570, the board
 * "Investigations States and Rules", "A stage failed"). The sentence is the
 * failed step's own entry in the task log, worded and sanitized as it was
 * saved; Copy Details takes the step, the evidence and the log around it,
 * never debug lines and never a password. Danger is only for a failure.
 */
export function FailureBanner({
  failures,
  entries,
  prepared,
  total,
}: {
  failures: PrepareFailure[];
  entries: TaskLogEntry[];
  prepared: number;
  total: number;
}) {
  const sentence = (f: PrepareFailure) =>
    [...entries]
      .reverse()
      .find(
        (e) =>
          e.kind === 'event' &&
          e.event.type === 'backup:step' &&
          e.event.status === 'error' &&
          e.event.label === f.label &&
          e.event.step === f.step
      )?.message ?? `${f.step} failed: ${f.reason}`;
  return (
    <div
      role="alert"
      className="flex items-start gap-4 rounded-xl p-5 shadow-elevation-1 bg-danger/10 border border-danger/30"
    >
      <XCircle className="text-danger shrink-0 mt-1" size="1.25rem" aria-hidden />
      <div className="flex-1 min-w-0 text-data flex flex-col gap-3">
        <p className="text-danger font-medium">
          {prepared} of {total} backup{total === 1 ? '' : 's'} prepared; {failures.length} couldn't be prepared.
        </p>
        <ul className="flex flex-col gap-2">
          {failures.map((f) => (
            <li key={f.label} className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <span className="font-mono">{f.label}</span>
                <span className="text-foreground">: {sentence(f)}</span>
              </div>
              <CopyButton
                text={() => failureDetails(entries, f)}
                label="Copy Details"
                title="Copy the step, the evidence and the log around it"
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
