import type { CSSProperties } from 'react';
import { Activity, Database, FileText, PlusCircle, Settings, Target, type LucideIcon } from 'lucide-react';

export type Section = 'workspace' | 'runs' | 'records' | 'iocs' | 'reports' | 'settings';

interface SectionInfo {
  label: string;
  icon: LucideIcon;
  /** The section colour's CSS custom property (DESIGN.md §9). */
  colorVar: string;
}

/**
 * The sidebar's sections, in order. A view's title is its sidebar label
 * (DESIGN.md §7), and its colour marks it in the sidebar, its title chip and
 * its empty states (§9).
 */
export const SECTIONS: Record<Section, SectionInfo> = {
  workspace: { label: 'New Investigation', icon: PlusCircle, colorVar: '--section-workspace' },
  runs: { label: 'Investigations', icon: Activity, colorVar: '--section-runs' },
  records: { label: 'Forensic Records', icon: Database, colorVar: '--section-records' },
  iocs: { label: 'Indicator Matches', icon: Target, colorVar: '--section-iocs' },
  reports: { label: 'Reports', icon: FileText, colorVar: '--section-reports' },
  // The app's own settings, not part of an investigation: at the foot of the
  // sidebar, in a neutral colour (EPOCH-560).
  settings: { label: 'Settings', icon: Settings, colorVar: '--section-settings' },
};

/** The investigation's sections, in order; Settings sits apart, below them. */
export const SECTION_ORDER: Section[] = ['workspace', 'runs', 'records', 'iocs', 'reports'];

/** Sets `--section` on an element, so `text-section` and `bg-section/NN` inside it use this section's colour. */
export function sectionStyle(section: Section): CSSProperties {
  return { ['--section' as string]: `var(${SECTIONS[section].colorVar})` };
}
