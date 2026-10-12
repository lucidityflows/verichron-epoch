import React from 'react';
import { Database, Activity, Target, FileText, PlusCircle } from 'lucide-react';

export type Section = 'workspace' | 'runs' | 'records' | 'iocs' | 'reports';

interface SidebarProps {
  active: Section;
  onSelect: (section: Section) => void;
  dbStatus: 'connected' | 'error' | 'unknown';
}

export function Sidebar({ active, onSelect, dbStatus }: SidebarProps) {
  const navItems = [
    { id: 'workspace', label: 'New Investigation', icon: PlusCircle },
    { id: 'runs', label: 'Investigations', icon: Activity },
    { id: 'records', label: 'Forensic Records', icon: Database },
    { id: 'iocs', label: 'Indicator Matches', icon: Target },
    { id: 'reports', label: 'Reports', icon: FileText },
  ] as const;

  return (
    <div className="w-64 bg-surface shadow-elevation-2 flex flex-col h-full">
      <div className="p-6 shadow-elevation-1">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-display text-foreground tracking-tight">Epoch</h1>
          <span className="text-2xs font-mono text-muted-foreground uppercase tracking-widest px-1.5 py-0.5 rounded bg-surface-raised shadow-elevation-1">
            v0.1
          </span>
        </div>
        <div className="flex items-center gap-2 mt-3 px-2.5 py-1 rounded-md bg-surface-raised/60 shadow-elevation-1 w-fit">
          <div
            className={`w-2 h-2 rounded-full shrink-0 ${
              dbStatus === 'connected'
                ? 'bg-accent shadow-xs shadow-accent/50'
                : dbStatus === 'error'
                  ? 'bg-danger shadow-xs shadow-danger/50'
                  : 'bg-muted-foreground animate-pulse'
            }`}
          />
          <span className="text-2xs font-mono text-muted-foreground font-medium tracking-wider">
            {dbStatus === 'connected' ? 'DB CONNECTED' : dbStatus === 'error' ? 'DB ERROR' : 'CONNECTING…'}
          </span>
        </div>
      </div>

      <nav className="flex-1 p-3 flex flex-col gap-1 overflow-y-auto">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onSelect(id as Section)}
            className={`flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-all cursor-pointer select-none ${
              active === id
                ? 'bg-accent/15 text-accent font-semibold shadow-elevation-1'
                : 'text-foreground/70 hover:bg-surface-raised hover:text-foreground'
            }`}
          >
            <Icon size="1.125rem" className="shrink-0" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
