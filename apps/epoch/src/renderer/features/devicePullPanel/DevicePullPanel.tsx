import React, { useRef, useEffect, useState } from 'react';
import {
  Smartphone,
  CheckCircle2,
  XCircle,
  Wrench,
  ArrowDown,
  Copy,
  Check,
  AlertTriangle,
  FolderOpen,
  RefreshCw,
  Terminal,
  Lock,
} from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Loader } from '../../components/ui/Loader';
import { useDevicePull } from '../../hooks/useDevicePull';
import { PasswordField } from '../../components/ui/PasswordField';
import { FieldError } from '../../components/ui/FieldError';
import { ToolSetup } from './ToolSetup';
 
interface DevicePullPanelProps {
  onBackupPulled: (destDir: string) => void;
}
 
export function DevicePullPanel({ onBackupPulled }: DevicePullPanelProps) {
  const {
    sources,
    sourceId,
    setSourceId,
    phase,
    toolStatus,
    actions,
    acquisitionOutput,
    acquisitionStep,
    acquisitionError,
    devices,
    selectedDevice,
    setSelectedDevice,
    destDir,
    pullProgress,
    pullError,
    runCompileFromSource,
    setupStatus,
    setupRun,
    setupSteps,
    setupOutput,
    setupFailure,
    setupNote,
    runSetup,
    handleSelectDestination,
    handlePull,
    checkAvailability,
  } = useDevicePull(onBackupPulled);

  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const terminalRef = useRef<HTMLPreElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
 
  const passwordProvided = password.trim() !== '';
 
  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };
 
  useEffect(() => {
    if (stickToBottom && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [acquisitionOutput, stickToBottom]);
 
  const handleTerminalScroll = () => {
    const el = terminalRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom <= 64);
  };
 
  const jumpToLatest = () => {
    setStickToBottom(true);
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  };

  const onPullClick = async () => {
    if (!password || password.trim() === '') {
      setPasswordError('A secure decryption password is required to create an encrypted backup.');
      return;
    }
    setPasswordError(null);
    try {
      await handlePull(password);
    } finally {
      setPassword('');
    }
  };

  if (!sourceId) return null;
 
  return (
    <div className="bg-surface shadow-elevation-1 rounded-xl p-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="p-2 rounded-lg bg-accent/10 text-accent">
          <Smartphone size="1.25rem" />
        </div>
        <h2 className="font-display text-heading text-foreground">Import from iPhone</h2>
        {sources.length > 1 && (
          <select
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className="ml-auto bg-surface-raised border border-border rounded-lg px-3 py-2 text-label font-mono text-foreground focus:border-accent focus:outline-none"
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}
      </div>
 
      {phase === 'checking' && !setupStatus && (
        <p className="text-data text-muted-foreground flex items-center gap-2 py-2">
          <Loader className="text-accent" /> Checking for the required tool…
        </p>
      )}

      {/* Guided setup (Linux, macOS). Stays on screen through the re-check
          that follows each run, so progress and failures don't flash away. */}
      {(phase === 'unavailable' || phase === 'checking') && setupStatus && (
        <ToolSetup
          status={setupStatus}
          running={setupRun}
          steps={setupSteps}
          output={setupOutput}
          failure={setupFailure}
          note={setupNote}
          onInstallSystem={() => runSetup('install')}
          onBuild={() => runSetup('build')}
          onCheckAgain={checkAvailability}
        />
      )}

      {/* Windows: the acquisition actions (WSL build). */}
      {phase === 'unavailable' && !setupStatus && toolStatus && !toolStatus.available && (
        <div>
          {/* Flag banner, standard 1 of 2 in this file -- see the Setup
           * Error card below. Both now share the same treatment
           * (rounded-xl, p-4, border-flag/30, shadow-elevation-1) per the
           * "all flag banners should be the same standard" directive on
           * VER-10. Previously this one was rounded-lg/px-4 py-3/
           * border-flag/20 with no elevation -- a different, weaker
           * treatment than its sibling three lines down for no reason
           * other than having been written at a different time. */}
          <div className="flex items-center gap-3 text-data text-flag bg-flag/10 border border-flag/30 shadow-elevation-1 p-4 rounded-xl mb-5">
            <XCircle size="1.125rem" className="shrink-0" />
            <span>iPhone import is not set up on this computer yet.</span>
          </div>
 
          {acquisitionError && (
            <div className="bg-flag/10 border border-flag/30 shadow-elevation-1 p-4 rounded-xl text-data text-flag mb-5">
              <div className="flex items-start gap-3">
                <AlertTriangle size="1.125rem" className="shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-flag">Setup failed</p>
                  <p className="text-foreground/90 mt-1 font-mono">{acquisitionError}</p>
                </div>
              </div>
            </div>
          )}
 
          {actions.map((action, i) => (
            <div key={i} className="rounded-xl p-5 mb-4 bg-surface/40 shadow-elevation-1 hover:shadow-elevation-2 hover:bg-surface/60 transition-all">
              <div className="flex items-start justify-between gap-4 mb-2">
                <div>
                  <h3 className="font-display text-heading text-foreground">
                    {action.kind === 'install-instructions'
                      ? 'Install the Required System Tools'
                      : action.kind === 'compile-from-source'
                      ? 'Set Up iPhone Import Automatically'
                      : 'Use a Verified Tool Package'}
                  </h3>
                  <p className="text-data text-muted-foreground mt-1">
                    {action.kind === 'install-instructions'
                      ? 'Complete this one-time setup in your terminal, then return here to import a backup directly from your iPhone.'
                      : action.kind === 'compile-from-source'
                      ? 'Epoch can build and configure the required components locally on this computer.'
                      : 'A verified package can provide the components needed for direct iPhone import.'}
                  </p>
                </div>
              </div>
              
              {action.kind === 'install-instructions' && (
                <div className="mt-4 pt-3 shadow-elevation-1">
                  <div className="text-label text-muted-foreground mb-2 flex items-center gap-1.5">
                    <Terminal size="0.875rem" /> Terminal command (one-time setup)
                  </div>
                  <div className="flex flex-col gap-2">
                    {action.commands.map((c: string, j: number) => (
                      <div
                        key={j}
                        className="flex items-center justify-between gap-3 bg-background/90 shadow-elevation-1 rounded-lg px-4 py-3 font-mono text-data text-foreground/90 group"
                      >
                        <span className="truncate select-all">
                          <span className="text-accent select-none mr-2">$</span>
                          {c}
                        </span>
                        {/* Icon + copied-state swap micro-interaction -- distinct enough
                            from a plain Button call site that it's deferred rather than
                            forced through the shared component this pass. */}
                        <button
                          type="button"
                          onClick={() => handleCopy(c, j)}
                          className="flex items-center gap-1 text-label font-sans text-muted-foreground hover:text-foreground bg-surface-raised shadow-elevation-1 px-3 py-1 rounded-md transition-colors shrink-0 cursor-pointer"
                          title="Copy command"
                        >
                          {copiedIndex === j ? (
                            <>
                              <Check size="0.75rem" className="text-accent" />
                              <span className="text-accent">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy size="0.75rem" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
 
              {action.kind === 'compile-from-source' && (
                <div className="mt-4">
                  <Button onClick={() => runCompileFromSource(action)}>
                    <Wrench size="1rem" /> {acquisitionError ? 'Retry Setup' : 'Build Automatically'}
                  </Button>
                </div>
              )}
 
              {action.kind === 'download-verified-release' && (
                <p className="text-data text-muted-foreground italic mt-3">
                  This option is not available yet. You can import an existing backup folder below instead.
                </p>
              )}
            </div>
          ))}
          
          <div className="mt-5">
            <Button variant="outline" size="sm" onClick={checkAvailability}>
              <RefreshCw size="0.875rem" /> Check Again
            </Button>
          </div>
        </div>
      )}
 
      {phase === 'acquiring' && (
        <div>
          <p className="text-data text-foreground flex items-center gap-2 mb-3">
            <Loader className="text-accent" /> {acquisitionStep ?? 'Working…'}
          </p>
          <div className="relative">
            <pre
              ref={terminalRef}
              onScroll={handleTerminalScroll}
              className="bg-background/90 shadow-elevation-1 rounded-xl p-4 text-data font-mono whitespace-pre-wrap overflow-auto max-h-72 text-foreground/80 leading-relaxed"
            >
              {acquisitionOutput.join('\n')}
            </pre>
            {!stickToBottom && acquisitionOutput.length > 0 && (
              <button
                onClick={jumpToLatest}
                className="absolute bottom-3 right-3 flex items-center gap-1.5 bg-accent text-background text-label rounded-full px-3 py-1.5 shadow-elevation-2 hover:bg-accent/90 transition-all cursor-pointer"
              >
                <ArrowDown size="0.75rem" />
                Jump to latest
              </button>
            )}
          </div>
        </div>
      )}
 
      {(phase === 'available' || phase === 'pulling' || phase === 'pulled') && toolStatus?.available && (
        <div>
          <div className="flex items-center gap-2 text-label text-accent uppercase tracking-wider mb-4">
            <CheckCircle2 size="1rem" /> Device service ready
          </div>
 
          {devices.length === 0 ? (
            <div className="p-4 rounded-lg bg-surface/50 shadow-elevation-1 text-data text-muted-foreground">
              No devices connected. Plug your iPhone in via USB and unlock the screen.
            </div>
          ) : (
            <div className="rounded-xl divide-y divide-border/60 mb-5 bg-surface/40 shadow-elevation-1 overflow-hidden">
              {devices.map((d) => (
                <label
                  key={d.id}
                  className={`flex items-center gap-4 px-4 py-4 text-data cursor-pointer transition-colors ${
                    selectedDevice?.id === d.id ? 'bg-accent/5' : 'hover:bg-surface/80'
                  }`}
                >
                  <input
                    type="radio"
                    name="device"
                    checked={selectedDevice?.id === d.id}
                    onChange={() => setSelectedDevice(d)}
                    className="accent-accent"
                  />
                  <span className="text-foreground">{d.name}</span>
                  {d.model && <Badge variant="neutral">{d.model}</Badge>}
                  {d.osVersion && <span className="text-label text-muted-foreground font-mono">iOS {d.osVersion}</span>}
                </label>
              ))}
            </div>
          )}
 
          {selectedDevice && (
            <div className="flex flex-col gap-3 mb-5 p-4 rounded-lg bg-surface/60 shadow-elevation-1">
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSelectDestination}
                  disabled={phase === 'pulling'}
                >
                  <FolderOpen size="0.875rem" />
                  {destDir ? 'Change Destination' : 'Choose Destination'}
                </Button>
                {destDir ? (
                  <span className="text-data font-mono text-foreground/80 truncate" title={destDir}>
                    {destDir}
                  </span>
                ) : (
                  <span className="text-data text-muted-foreground italic">No destination chosen yet</span>
                )}
              </div>

              {/* Secure Backup Password Input */}
              <div className="mt-2 pt-3 shadow-elevation-1">
                <label className="text-label text-foreground mb-1 flex items-center gap-2">
                  <Lock size="0.875rem" className="text-accent" /> Backup encryption password (required)
                </label>
                <p className="text-data text-muted-foreground mb-2">
                  Unencrypted backups omit sensitive artifacts like Keychain and Health data. Epoch will enforce encryption during creation using this password.
                </p>
                <PasswordField
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); if (passwordError) setPasswordError(null); }}
                  disabled={phase === 'pulling'}
                  placeholder="Enter temporary backup password"
                  invalid={!!passwordError}
                />
                <FieldError>{passwordError}</FieldError>
              </div>
            </div>
          )}
 
          {selectedDevice && destDir && phase !== 'pulled' && (
            <Button
              onClick={onPullClick}
              disabled={!passwordProvided}
              loading={phase === 'pulling'}
              loadingText="Pulling encrypted backup…"
              title={!passwordProvided ? 'Enter a backup password to continue' : undefined}
            >
              Pull Encrypted Backup
            </Button>
          )}
 
          {pullProgress.length > 0 && (
            <pre className="bg-background/90 shadow-elevation-1 rounded-xl p-4 text-data font-mono whitespace-pre-wrap overflow-auto max-h-48 text-foreground/80 mt-5 leading-relaxed">
              {pullProgress.map((p) => p.message).join('\n')}
            </pre>
          )}
          {pullError && (
            <div className="text-data text-danger bg-danger/10 border border-danger/30 shadow-elevation-1 rounded-lg p-4 mt-4 flex items-center gap-2">
              <XCircle size="1rem" className="shrink-0" />
              <span>{pullError}</span>
            </div>
          )}
          {phase === 'pulled' && (
            <div className="text-data text-accent bg-accent/10 border border-accent/30 shadow-elevation-1 rounded-lg p-4 mt-4 flex items-center gap-2">
              <CheckCircle2 size="1.125rem" className="shrink-0" />
              <span>Encrypted backup imported successfully and ready for analysis.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}