import type { BrowserWindow } from 'electron';

/**
 * Windows besides the main one that follow the running task: the Activity
 * Log's pop-out (EPOCH-570). The pipeline sends every log entry and state
 * change to them as well as to the main window.
 */
const popOuts = new Set<BrowserWindow>();

export function addPopOut(window: BrowserWindow): void {
  popOuts.add(window);
  window.on('closed', () => popOuts.delete(window));
}

export function popOutWindows(): BrowserWindow[] {
  return [...popOuts].filter((window) => !window.isDestroyed());
}
