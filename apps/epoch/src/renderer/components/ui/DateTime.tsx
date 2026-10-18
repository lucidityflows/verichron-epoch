import {
  DEFAULT_ZONE,
  formatDateParts,
  formatParts,
  isoWithOffset,
  NO_TIME,
  type DisplayZone,
  type TimeValue,
} from '../../../shared/time';
import { cn } from '../../libs/utils';

interface DateTimeProps {
  value: TimeValue | null | undefined;
  /** UTC unless the examiner chose a zone (EPOCH-560). */
  zone?: DisplayZone;
  /** Show the date only. */
  dateOnly?: boolean;
  className?: string;
}

/**
 * A date and time as the board "Time Display Rules" shows it: the value in
 * monospace, its zone beside it in muted label text, and the exact ISO time
 * with its offset on hover (EPOCH-559). A recorded calendar date has no zone
 * to show. A missing time says so; it is never guessed (R11).
 */
export function DateTime({ value, zone = DEFAULT_ZONE, dateOnly = false, className }: DateTimeProps) {
  const parts = dateOnly ? formatDateParts(value, zone) : formatParts(value, zone);
  if (!parts) return <span className={cn('text-muted-foreground', className)}>{NO_TIME}</span>;
  return (
    <span className={cn('whitespace-nowrap', className)} title={isoWithOffset(value!, zone)}>
      <span className="font-mono">{parts.value}</span>
      {parts.label && <span className="text-label text-muted-foreground ml-1">{parts.label}</span>}
    </span>
  );
}
