import { create } from 'zustand';

import type { LogFilter, LogView } from '../../../shared/activityLog';

/**
 * How the docked Activity Log is set, for the session (EPOCH-575). The dock is
 * drawn only on New Investigation, so leaving the page removes it; kept here,
 * the drawer comes back as the examiner left it (open or closed, the view and
 * the filter) instead of closed. The pop-out window keeps its own, always open.
 */
interface DockState {
  open: boolean;
  view: LogView;
  filter: LogFilter;
  setOpen: (open: boolean) => void;
  setView: (view: LogView) => void;
  setFilter: (filter: LogFilter) => void;
}

export const useDockState = create<DockState>((set) => ({
  open: false,
  view: 'summary',
  filter: 'all',
  setOpen: (open) => set({ open }),
  setView: (view) => set({ view }),
  setFilter: (filter) => set({ filter }),
}));
