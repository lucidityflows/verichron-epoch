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
  ShieldCheck,
  ArrowRight,
} from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Loader } from '../../components/ui/Loader';
import { useDevicePull } from '../../hooks/useDevicePull';
import { PasswordField } from '../../components/ui/PasswordField';
import { FieldError } from '../../components/ui/FieldError';
import { ToolSetup } from './ToolSetup';
import { StepList, type Step } from '../../components/ui/StepList';
import { CopyButton } from '../../components/ui/CopyButton';
import { BackupProgressCard, DestinationBackupNotice, formatBytes, IncompleteBackupNotice } from './BackupProgressCard';
import type { DeviceInfo } from '../../../shared/types/tools';

/**
 * What the Copy button on a pull error copies: enough to diagnose it
 * elsewhere. The device's UDID is replaced, since the copy may be pasted
 * somewhere public; the password never reaches the tool's output (R30).
 */
function pullDiagnostics(error: string, device: DeviceInfo | null, log: string[]): string {
  const deviceLine = device
    ? `${device.name}${device.model ? ` (${device.model})` : ''}${device.osVersion ? `, iOS ${device.osVersion}` : ''}`
    : 'none selected';
  const text = [`Epoch iPhone pull failed`, `Device: ${deviceLine}`, `Error: ${error}`, '', 'Log:', ...log].join('\n');
  return device ? text.split(device.id).join('<device UDID>') : text;
}

interface DevicePullPanelProps {
  onBackupPulled: (destDir: string) => void;
  /** Returns to the choice of import source; unavailable while a pull runs. */
  onChangeSource: () => void;
}

export function DevicePullPanel({ onBackupPulled, onChangeSource }: DevicePullPanelProps) {
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
    encryptionConsent,
    cancelEncryptionConsent,
    deviceAction,
    pullStats,
    pulledAt,
    cancelPull,
    cancelling,
    incomplete,
    deleteIncomplete,
    deletingIncomplete,
    destinationBackup,
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
  } = useDevicePull();

  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  // Incomplete backups in other folders the user set aside; not shown again this session.
  const [setAside, setSetAside] = useState<string[]>([]);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const terminalRef = useRef<HTMLPreElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  const passwordProvided = password.trim() !== '';

  // The password is asked for only once there is a device and a folder to pull
  // to, and it doesn't outlive either (EPOCH-467, DESIGN.md §8): choosing
  // another device or folder clears it, and so does the pull starting, which
  // already has it.
  const clearPassword = () => {
    setPassword('');
    setPasswordError(null);
  };
  const onChooseDevice = (device: DeviceInfo) => {
    if (device.id !== selectedDevice?.id) clearPassword();
    setSelectedDevice(device);
  };
  const onChooseDestination = async () => {
    if (await handleSelectDestination()) clearPassword();
  };

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

  const onPullClick = async (enableEncryption = false) => {
    if (!password || password.trim() === '') {
      setPasswordError('A backup password is required.');
      return;
    }
    setPasswordError(null);
    let result: 'consent-needed' | 'finished' = 'finished';
    try {
      result = await handlePull(password, enableEncryption, clearPassword);
    } finally {
      // Kept while the user decides whether to turn on encrypted backups.
      if (result !== 'consent-needed') setPassword('');
    }
  };

  const onCancelConsent = () => {
    cancelEncryptionConsent();
    setPassword('');
  };

  const pullLocked = phase === 'pulling' || encryptionConsent;
  // A destination that already holds a backup of the device is refused (EPOCH-483), so
  // there is nothing to ask a password for until another folder is chosen.
  const askPassword = !!selectedDevice && !!destDir && !destinationBackup && phase !== 'pulling' && phase !== 'pulled';

  // The step rail (DESIGN.md §9): each step's state, in order.
  const started = phase === 'pulling' || phase === 'pulled';
  const pullSteps: Step[] = [
    { label: 'Device', state: selectedDevice ? 'done' : 'current' },
    {
      label: 'Destination',
      state: !selectedDevice ? 'pending' : destinationBackup ? 'blocked' : destDir ? 'done' : 'current',
    },
    {
      label: 'Password',
      state: started ? 'done' : !askPassword ? 'pending' : passwordProvided ? 'done' : 'current',
    },
    {
      label: 'Pull',
      state: phase === 'pulled' ? 'done' : started || (askPassword && passwordProvided) ? 'current' : 'pending',
    },
  ];

  if (!sourceId) return null;

  return (
    <div className="bg-surface shadow-elevation-1 rounded-xl p-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="p-2 rounded-lg bg-accent/10 text-accent">
          <Smartphone size="1.25rem" />
        </div>
        <h2 className="font-display text-heading text-foreground">Pull from a Connected iPhone</h2>
        {sources.length > 1 && (
          <select
            disabled={pullLocked}
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
        <Button
          variant="outline"
          size="sm"
          onClick={onChangeSource}
          disabled={pullLocked}
          title={pullLocked ? 'Finish or cancel the pull first' : 'Choose another way to import'}
          className={sources.length > 1 ? 'shrink-0' : 'ml-auto shrink-0'}
        >
          Change
        </Button>
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
            <div className="bg-danger/10 border border-danger/30 shadow-elevation-1 p-4 rounded-xl text-data text-danger mb-5">
              <div className="flex items-start gap-3">
                <AlertTriangle size="1.125rem" className="shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-danger">Setup failed</p>
                  <p className="text-foreground/90 mt-1 font-mono">{acquisitionError}</p>
                </div>
              </div>
            </div>
          )}

          {actions.map((action, i) => (
            <div
              key={i}
              className="rounded-xl p-5 mb-4 bg-surface-raised shadow-elevation-1 hover:shadow-elevation-2 hover:bg-surface transition-all"
            >
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
                        className="flex items-center justify-between gap-3 bg-inset shadow-elevation-1 rounded-lg px-4 py-3 font-mono text-data text-foreground/90 group"
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
                              <Check size="0.75rem" className="text-success" />
                              <span className="text-success">Copied</span>
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
              className="bg-inset shadow-elevation-1 rounded-xl p-4 text-data font-mono whitespace-pre-wrap overflow-auto max-h-72 text-foreground/80 leading-relaxed"
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
          <div className="flex items-center gap-1.5 text-label text-success mb-4">
            <CheckCircle2 size="1rem" /> Device service ready
          </div>

          <StepList steps={pullSteps} label="Pull steps" />

          {devices.length === 0 ? (
            // The current step, and the examiner has to act: accent, with its action as the primary button (§9).
            <div className="flex items-center gap-4 p-4 rounded-xl bg-accent/10 border border-accent/30 shadow-elevation-1">
              <div className="p-3 rounded-full bg-accent/20 text-accent shrink-0">
                <Smartphone size="1.25rem" className="animate-pulse" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-display text-heading text-foreground">Connect an iPhone</p>
                <p className="text-data text-muted-foreground">
                  Plug the iPhone into this computer by USB and unlock its screen, then check again.
                </p>
              </div>
              <Button size="sm" onClick={checkAvailability} className="shrink-0">
                <RefreshCw size="0.875rem" /> Check Again
              </Button>
            </div>
          ) : (
            <div className="mb-5">
              <p className="text-label text-foreground mb-2">Choose the iPhone to back up</p>
              <div className="flex flex-col gap-3" role="radiogroup" aria-label="iPhone to back up">
                {devices.map((d) => {
                  const selected = selectedDevice?.id === d.id;
                  // A selectable option (DESIGN.md §9): an accent outline on hover, filled when selected.
                  return (
                    <label
                      key={d.id}
                      className={`group flex items-center gap-4 rounded-xl border-2 px-4 py-4 text-data transition-all has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
                        pullLocked ? 'cursor-not-allowed' : 'cursor-pointer'
                      } ${
                        selected
                          ? 'border-accent bg-accent/10 shadow-elevation-2'
                          : 'border-accent/30 bg-surface-raised shadow-elevation-1 hover:border-accent hover:shadow-elevation-2'
                      }`}
                    >
                      <input
                        type="radio"
                        name="device"
                        checked={selected}
                        onChange={() => onChooseDevice(d)}
                        disabled={pullLocked}
                        className="sr-only"
                      />
                      <span
                        className={`p-2 rounded-lg shrink-0 ${selected ? 'bg-accent text-background' : 'bg-accent/10 text-accent'}`}
                      >
                        <Smartphone size="1.25rem" />
                      </span>
                      <span className="flex flex-1 min-w-0 items-center gap-3">
                        <span className="font-display text-heading text-foreground truncate">{d.name}</span>
                        {d.model && <Badge variant="neutral">{d.model}</Badge>}
                        {d.osVersion && (
                          <span className="text-label text-muted-foreground font-mono">iOS {d.osVersion}</span>
                        )}
                      </span>
                      <span
                        className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-label transition-colors ${
                          selected ? 'bg-accent/20 text-accent' : 'bg-accent text-background shadow-elevation-2'
                        }`}
                      >
                        {selected ? (
                          <>
                            <Check size="0.875rem" /> Selected
                          </>
                        ) : (
                          'Select'
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {selectedDevice && (
            <div className="flex flex-col gap-3 mb-5 p-4 rounded-lg bg-surface-raised shadow-elevation-1">
              <p className="text-label text-foreground">Choose where to save the backup</p>
              <div className="flex items-center gap-3">
                {/* The current step's action is the primary button (DESIGN.md §9). */}
                <Button
                  variant={destDir ? 'outline' : 'accent'}
                  size="sm"
                  onClick={onChooseDestination}
                  disabled={pullLocked}
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

              {askPassword && (
                <div className="mt-2 pt-3 shadow-elevation-1">
                  <label className="text-label text-foreground mb-1 flex items-center gap-2">
                    <Lock size="0.875rem" className="text-accent" /> Backup password (required)
                  </label>
                  <p className="text-data text-muted-foreground mb-2">
                    Epoch makes encrypted backups only, because unencrypted ones leave out Keychain and Health data. If
                    this iPhone already makes encrypted backups, enter its backup password. Otherwise, this becomes its
                    backup password.
                  </p>
                  <PasswordField
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (passwordError) setPasswordError(null);
                    }}
                    disabled={pullLocked}
                    placeholder="Backup password"
                    invalid={!!passwordError}
                  />
                  <FieldError>{passwordError}</FieldError>
                </div>
              )}
            </div>
          )}

          {selectedDevice && encryptionConsent && (
            <section className="rounded-lg bg-flag/10 border border-flag/30 shadow-elevation-1 p-5 flex flex-col gap-3">
              <h3 className="flex items-center gap-2 font-display text-heading text-foreground">
                <ShieldCheck size="1.125rem" className="text-flag" /> Turn On Encrypted Backups?
              </h3>
              <p className="text-data text-foreground">
                Encrypted backups are off on {selectedDevice.name}. To continue, Epoch will turn them on with the
                password you entered.
              </p>
              <ul className="text-data text-muted-foreground list-disc pl-5 flex flex-col gap-1">
                <li>You'll unlock {selectedDevice.name} and enter its passcode on it to approve the change.</li>
                <li>The setting stays on after the backup, and later backups of this iPhone use this password.</li>
                <li>Epoch records the change with this pull.</li>
              </ul>
              <div className="flex items-center gap-3 mt-1">
                <Button onClick={() => onPullClick(true)}>
                  <ShieldCheck size="1rem" /> Turn On and Continue
                </Button>
                <Button variant="outline" onClick={onCancelConsent}>
                  Cancel
                </Button>
              </div>
            </section>
          )}

          {selectedDevice && destDir && phase !== 'pulled' && !encryptionConsent && (
            <Button
              onClick={() => onPullClick()}
              disabled={!passwordProvided || !!destinationBackup}
              loading={phase === 'pulling'}
              loadingText="Pulling encrypted backup…"
              title={
                destinationBackup
                  ? 'This folder already holds a backup of this device'
                  : !passwordProvided
                    ? 'Enter a backup password to continue'
                    : undefined
              }
            >
              Pull Encrypted Backup
            </Button>
          )}

          {deviceAction && phase === 'pulling' && (
            <div
              role="alert"
              className="flex items-center gap-4 bg-flag/10 border border-flag/30 shadow-elevation-1 rounded-lg p-5 mt-5"
            >
              <div className="p-3 rounded-full bg-flag/20 text-flag shrink-0">
                <Smartphone size="1.5rem" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-display text-heading text-flag">
                  Action Needed on {selectedDevice?.name ?? 'the iPhone'}
                </h3>
                <p className="text-data text-foreground mt-1">{deviceAction}</p>
              </div>
              <Loader className="text-flag" />
            </div>
          )}

          {phase === 'pulling' && pullStats && (
            <BackupProgressCard stats={pullStats} cancelling={cancelling} onCancel={cancelPull} />
          )}

          {pullProgress.length > 0 && (
            <pre className="bg-inset shadow-elevation-1 rounded-xl p-4 text-data font-mono whitespace-pre-wrap overflow-auto max-h-48 text-foreground/80 mt-5 leading-relaxed">
              {pullProgress.map((p) => p.message).join('\n')}
            </pre>
          )}
          {pullError && (
            <div className="text-data text-danger bg-danger/10 border border-danger/30 shadow-elevation-1 rounded-lg p-4 mt-4 flex items-start gap-2">
              <XCircle size="1rem" className="shrink-0 mt-0.5" />
              <span className="flex-1 min-w-0">{pullError}</span>
              <CopyButton
                title="Copy the error, device and log"
                text={() =>
                  pullDiagnostics(
                    pullError,
                    selectedDevice,
                    pullProgress.map((p) => p.message)
                  )
                }
              />
            </div>
          )}
          {phase !== 'pulling' &&
            selectedDevice &&
            destinationBackup &&
            // An unfinished backup here is shown below, with Delete It, once its size is known.
            !(
              destinationBackup.state === 'unfinished' &&
              incomplete.some((backup) => backup.path === destinationBackup.path)
            ) && (
              <DestinationBackupNotice
                deviceName={selectedDevice.name}
                destination={destinationBackup}
                onChooseAnotherFolder={onChooseDestination}
              />
            )}
          {phase !== 'pulling' &&
            selectedDevice &&
            incomplete
              .filter((backup) => backup.path === destinationBackup?.path || !setAside.includes(backup.path))
              .map((backup) => {
                const blocksPull = backup.path === destinationBackup?.path;
                return (
                  <IncompleteBackupNotice
                    key={backup.path}
                    deviceName={selectedDevice.name}
                    incomplete={backup}
                    deleting={deletingIncomplete === backup.path}
                    blocksPull={blocksPull}
                    onDelete={() => deleteIncomplete(backup)}
                    secondary={
                      blocksPull
                        ? { label: 'Choose Another Folder', onClick: onChooseDestination }
                        : { label: 'Not Now', onClick: () => setSetAside((prev) => [...prev, backup.path]) }
                    }
                  />
                );
              })}
          {phase === 'pulled' && destDir && (
            // The pull's results (EPOCH-437): what was made, then the one next step.
            <div className="bg-success/10 border border-success/30 shadow-elevation-1 rounded-lg p-5 mt-4">
              <p className="flex items-center gap-2 font-display text-heading text-success mb-3">
                <CheckCircle2 size="1.25rem" className="shrink-0" /> Backup Pulled and Verified
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-data mb-4">
                {selectedDevice && (
                  <>
                    <dt className="text-muted-foreground">Device</dt>
                    <dd className="text-foreground">{selectedDevice.name}</dd>
                  </>
                )}
                {pullStats && (
                  <>
                    <dt className="text-muted-foreground">Size</dt>
                    <dd className="text-foreground">{formatBytes(pullStats.receivedBytes)}</dd>
                  </>
                )}
                {pulledAt !== null && (
                  <>
                    <dt className="text-muted-foreground">Finished</dt>
                    <dd className="text-foreground">{new Date(pulledAt).toLocaleString()}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Saved to</dt>
                <dd className="font-mono text-foreground truncate" title={destDir}>
                  {destDir}
                </dd>
              </dl>
              <Button onClick={() => onBackupPulled(destDir)}>
                Continue to Prepare Evidence
                <ArrowRight size="1rem" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
