import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  Download,
  RefreshCw,
  ShieldCheck,
  SkipForward,
  XCircle,
} from 'lucide-react';
import type {
  ToolSetupFailure,
  ToolSetupGroup,
  ToolSetupRequirement,
  ToolSetupStatus,
  ToolSetupStep,
} from '../../../shared/types/tools';
import { Button } from '../../components/ui/Button';
import { Loader } from '../../components/ui/Loader';
import { TerminalLog } from '../../components/layout/TerminalLog';

interface ToolSetupProps {
  status: ToolSetupStatus;
  running: 'install' | 'build' | null;
  steps: ToolSetupStep[];
  output: string[];
  failure: ToolSetupFailure | null;
  note: string | null;
  onInstallSystem: () => void;
  onBuild: () => void;
  onCheckAgain: () => void;
}

const GROUP_TITLES: Record<ToolSetupGroup, string> = {
  system: 'System Tools',
  service: 'Device Service',
  libraries: 'iPhone Libraries',
};

/**
 * Guided setup for iPhone import (EPOCH-465): what this computer needs, what
 * it already has, and one action at a time to install the rest, with each
 * step's progress and a clear cause when one fails. DESIGN.md §1 (banners),
 * §2 (type scale), §7 (wording).
 */
export function ToolSetup({
  status,
  running,
  steps,
  output,
  failure,
  note,
  onInstallSystem,
  onBuild,
  onCheckAgain,
}: ToolSetupProps) {
  const groups = useMemo(() => {
    const order: ToolSetupGroup[] = ['system', 'service', 'libraries'];
    return order
      .map((group) => ({ group, items: status.requirements.filter((r) => r.group === group) }))
      .filter((g) => g.items.length > 0);
  }, [status.requirements]);
  const libraryCount = status.requirements.filter((r) => r.group === 'libraries').length;
  const logLines = useMemo(() => output.map((line) => ({ stream: 'stdout' as const, line })), [output]);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-data text-muted-foreground">
        iPhone import needs a few components on this computer. Epoch checks what's already here and installs
        what's missing.
      </p>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))' }}>
        {groups.map(({ group, items }) => (
          <section key={group} className="rounded-lg bg-surface/40 shadow-elevation-1 p-4">
            <h3 className="text-label uppercase tracking-wider text-muted-foreground mb-3">{GROUP_TITLES[group]}</h3>
            <ul className="flex flex-col gap-3">
              {items.map((req) => (
                <RequirementRow key={req.id} requirement={req} />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {steps.length > 0 && <StepList steps={steps} />}

      {failure && !running && <FailureBanner failure={failure} />}

      {note && !running && (
        <div className="flex items-start gap-3 text-data text-accent bg-accent/10 border border-accent/30 shadow-elevation-1 rounded-lg p-4">
          <ShieldCheck size="1.125rem" className="shrink-0 mt-0.5" />
          <span>{note}</span>
        </div>
      )}

      {!running && !status.systemReady && status.install && (
        <ActionCard
          title="Install System Tools"
          description={status.install.note}
          command={status.install.command}
          packages={status.install.packages}
        >
          {status.install.automatic && (
            <Button onClick={onInstallSystem}>
              <Download size="1rem" /> Install System Tools
            </Button>
          )}
          <Button variant="outline" onClick={onCheckAgain}>
            <RefreshCw size="0.875rem" /> Check Again
          </Button>
        </ActionCard>
      )}

      {!running && status.systemReady && !status.installed && (
        <ActionCard
          title="Install iPhone Libraries"
          description={`Builds ${libraryCount} libraries from verified releases into Epoch's own tools folder. This takes a few minutes.`}
        >
          <Button onClick={onBuild}>
            <Download size="1rem" /> {status.canResume || failure ? 'Resume Installation' : 'Install iPhone Libraries'}
          </Button>
          <Button variant="outline" onClick={onCheckAgain}>
            <RefreshCw size="0.875rem" /> Check Again
          </Button>
        </ActionCard>
      )}

      {(running || output.length > 0) && (
        <TerminalLog lines={logLines} live={running !== null} label="Setup details" />
      )}
    </div>
  );
}

function RequirementRow({ requirement }: { requirement: ToolSetupRequirement }) {
  const { ok, group, label, version, detail } = requirement;
  const Icon = ok ? CheckCircle2 : group === 'libraries' ? Circle : XCircle;
  const tone = ok ? 'text-accent' : group === 'libraries' ? 'text-muted-foreground' : 'text-flag';
  return (
    <li className="flex items-start gap-3">
      <Icon size="1rem" className={`${tone} shrink-0 mt-0.5`} aria-label={ok ? 'Installed' : 'Missing'} />
      <div className="min-w-0">
        <p className="text-data text-foreground">
          {label}
          {version && <span className="ml-2 font-mono text-muted-foreground">{version}</span>}
        </p>
        {detail && <p className="text-data text-muted-foreground">{detail}</p>}
      </div>
    </li>
  );
}

const STEP_ICONS: Record<ToolSetupStep['status'], React.ReactNode> = {
  pending: <Circle size="1rem" className="text-muted-foreground" />,
  running: <Loader className="text-accent" />,
  done: <CheckCircle2 size="1rem" className="text-accent" />,
  failed: <XCircle size="1rem" className="text-flag" />,
  skipped: <SkipForward size="1rem" className="text-muted-foreground" />,
};

function StepList({ steps }: { steps: ToolSetupStep[] }) {
  return (
    <ol className="rounded-lg bg-surface/40 shadow-elevation-1 divide-y divide-border/40">
      {steps.map((step) => (
        <li key={step.id} className="flex items-center gap-3 px-4 py-3">
          <span className="w-4 flex justify-center shrink-0">{STEP_ICONS[step.status]}</span>
          <span className={`text-data ${step.status === 'pending' ? 'text-muted-foreground' : 'text-foreground'}`}>
            {step.label}
          </span>
          {step.detail && <span className="text-data text-muted-foreground ml-auto">{step.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

function FailureBanner({ failure }: { failure: ToolSetupFailure }) {
  return (
    <div className="flex items-start gap-3 text-data text-flag bg-flag/10 border border-flag/30 shadow-elevation-1 rounded-lg p-4">
      <AlertTriangle size="1.125rem" className="shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p>{failure.label} failed.</p>
        {failure.hint && <p className="text-foreground mt-1">{failure.hint}</p>}
        {failure.tail.length > 0 && (
          <pre className="mt-3 bg-background/90 shadow-elevation-1 rounded-lg p-3 text-data font-mono text-foreground/80 whitespace-pre-wrap overflow-auto max-h-48">
            {failure.tail.join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
}

interface ActionCardProps {
  title: string;
  description?: string;
  command?: string;
  packages?: string[];
  children: React.ReactNode;
}

function ActionCard({ title, description, command, packages, children }: ActionCardProps) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!command) return;
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <section className="rounded-lg bg-surface/40 shadow-elevation-1 p-5 flex flex-col gap-3">
      <h3 className="font-display text-heading text-foreground">{title}</h3>
      {description && <p className="text-data text-muted-foreground">{description}</p>}
      {packages && packages.length > 0 && (
        <p className="text-data text-muted-foreground">
          Packages: <span className="font-mono text-foreground">{packages.join(', ')}</span>
        </p>
      )}
      {command && (
        <div className="flex items-center justify-between gap-3 bg-background/90 shadow-elevation-1 rounded-lg px-4 py-3 font-mono text-data text-foreground/90">
          <span className="truncate select-all">
            <span className="text-accent select-none mr-2">$</span>
            {command}
          </span>
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 text-label font-sans text-muted-foreground hover:text-foreground bg-surface-raised shadow-elevation-1 px-3 py-1 rounded-md transition-colors shrink-0 cursor-pointer"
            title="Copy command"
          >
            {copied ? (
              <>
                <Check size="0.75rem" className="text-accent" /> <span className="text-accent">Copied</span>
              </>
            ) : (
              <>
                <Copy size="0.75rem" /> <span>Copy</span>
              </>
            )}
          </button>
        </div>
      )}
      <div className="flex items-center gap-3 mt-1">{children}</div>
    </section>
  );
}
