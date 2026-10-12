/**
 * Process groups the processor started with `detached: true` (mvt-ios
 * check-backup, iLEAPP), so a timeout or a failed log can stop a tool and
 * everything it started. Being its own group, such a tool no longer receives
 * a SIGINT or SIGTERM sent to the processor (Ctrl-C in a terminal, or a stop
 * from its parent), and would keep writing its output after the processor
 * ended (EPOCH-486). While any group is running, those signals are forwarded
 * to every group, and then the processor ends as the signal would end it.
 */

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const groups = new Set<number>();
const handlers = new Map<NodeJS.Signals, () => void>();

function forward(signal: NodeJS.Signals): void {
  for (const pid of groups) {
    try {
      process.kill(-pid, signal);
    } catch {
      // already gone
    }
  }
  groups.clear();
  uninstall();
  // No handler is left, so the signal now ends the processor the usual way.
  process.kill(process.pid, signal);
}

function install(): void {
  for (const signal of SIGNALS) {
    const handler = () => forward(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function uninstall(): void {
  for (const [signal, handler] of handlers) process.off(signal, handler);
  handlers.clear();
}

/** Tracks a detached child's process group; call the returned function once the child has exited. */
export function trackProcessGroup(pid: number | undefined): () => void {
  if (pid === undefined) return () => {};
  if (groups.size === 0) install();
  groups.add(pid);
  return () => {
    groups.delete(pid);
    if (groups.size === 0) uninstall();
  };
}

/** Stops a tracked group immediately, with everything it started. */
export function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // not started, or already gone
  }
}
