import { useToast } from '../../components/ui/Toast';
import { ActivityLog } from './ActivityLog';
import { useActivityLog } from './useActivityLog';

/** The Activity Log docked at the bottom of the content area, for the task New Investigation runs (EPOCH-570). */
export function ActivityLogDock() {
  const source = useActivityLog();
  return <ActivityLogFor source={source} mode="docked" />;
}

/** The Activity Log in its own window, following the same task (EPOCH-570). */
export function ActivityLogWindow() {
  const source = useActivityLog();
  return <ActivityLogFor source={source} mode="window" />;
}

function ActivityLogFor({ source, mode }: { source: ReturnType<typeof useActivityLog>; mode: 'docked' | 'window' }) {
  const { show } = useToast();
  const { workspace, file } = source;
  const saveAs =
    workspace && file
      ? () =>
          window.epoch.saveTaskLogAs(workspace, file).then(
            ({ saved }) => saved && show(`Activity Log saved to ${saved}`, 'success'),
            (err: unknown) =>
              show(`The Activity Log could not be saved: ${err instanceof Error ? err.message : String(err)}`, 'danger')
          )
      : undefined;
  return (
    <ActivityLog
      entries={source.entries}
      live={source.live}
      error={source.error}
      mode={mode}
      onSaveAs={saveAs}
      onPopOut={mode === 'docked' ? () => void window.epoch.popOutActivityLog() : undefined}
    />
  );
}
