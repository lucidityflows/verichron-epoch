import { useState } from 'react';
import {
  Smartphone,
  CheckCircle2,
  XCircle,
  Wrench,
  AlertTriangle,
  FolderOpen,
  RefreshCw,
  Terminal,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Loader } from '../../components/ui/Loader';
import { useDevicePull } from '../../hooks/useDevicePull';
import { PasswordField } from '../../components/ui/PasswordField';
import { FieldError } from '../../components/ui/FieldError';
import { TerminalLog } from '../../components/layout/TerminalLog';
import { ToolSetup } from './ToolSetup';
import { StepList, type Step } from '../../components/ui/StepList';
import { CopyButton } from '../../components/ui/CopyButton';
import { IncompleteBackupNotice } from './BackupProgressCard';
import { DeviceOption, PulledCard, PullingCard, deviceTitle, useShownPath } from './PullParts';
import type { DeviceInfo } from '../../../shared/types/tools';

/**
 * What Copy Details on a pull error copies: enough to diagnose it elsewhere.
 * The device's UDID is replaced, since the copy may be pasted somewhere
 * public; the password never reaches the tool's output (R30).
 */
function pullDiagnostics(error: string, device: DeviceInfo | null, log: string[]): string {
  const text = [
    `Epoch iPhone pull failed`,
    // The recorded model ("iPhone17,5"), not the shown one, so it matches the tool's output.
    `Device: ${device ? `${device.model ?? device.name}${device.osVersion ? `, iOS ${device.osVersion}` : ''}` : 'none selected'}`,
    `Error: ${error}`,
    '',
    'Log:',
    ...log,
  ].join('\n');
  return device ? text.split(device.id).join('<device UDID>') : text;
}

/** A link-styled control inside a summary line ("Change"). */
function LinkButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-label text-accent hover:underline disabled:text-muted-foreground disabled:no-underline disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

interface DevicePullPanelProps {
  onBackupPulled: (destDir: string) => void;
  /** Returns to the choice of import source; unavailable while a pull runs. */
  onChangeSource: () => void;
}

/**
 * Pulling a backup from a connected iPhone, following the board "iPhone Pull
 * Flow" (EPOCH-554, U3b). While choosing, one card holds the pull's own small
 * step rail (Device, Destination, Password, Start), and each finished choice
 * folds into a summary line. While pulling, the card is replaced by the running
 * pull, with progress and Cancel in its first lines (DESIGN.md §10).
 */
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
    pullSteps,
    pullError,
    pullCancelled,
    encryptionConsent,
    cancelEncryptionConsent,
    deviceAction,
    pullStats,
    cancelPull,
    cancelling,
    incomplete,
    deleteIncomplete,
    deletingIncomplete,
    crashReports,
    copyCrashReportsAgain,
    copyingCrashReports,
    pulledDir,
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
  const [starting, setStarting] = useState(false);
  // Incomplete backups in other folders the user set aside; not shown again this session.
  const [setAside, setSetAside] = useState<string[]>([]);
  const destShown = useShownPath(destDir);
  const savedShown = useShownPath(pulledDir ?? destDir);

  const passwordProvided = password.trim() !== '';

  // The password is asked for only once there is a device and a folder to pull
  // to, and it doesn't outlive either (EPOCH-467, DESIGN.md §8): choosing
  // another device or folder clears it, and so does the pull starting, which
  // already has it.
  const clearPassword = () => {
    setPassword('');
    setPasswordError(null);
  };
  const onChooseDevice = (device: DeviceInfo | null) => {
    if (device?.id !== selectedDevice?.id) clearPassword();
    setSelectedDevice(device);
  };
  const onChooseDestination = async () => {
    if (await handleSelectDestination()) clearPassword();
  };

  const onPullClick = async (enableEncryption = false) => {
    if (!password || password.trim() === '') {
      setPasswordError('A backup password is required.');
      return;
    }
    setPasswordError(null);
    setStarting(true);
    let result: 'consent-needed' | 'finished' = 'finished';
    try {
      result = await handlePull(password, enableEncryption, () => {
        clearPassword();
        setStarting(false);
      });
    } finally {
      setStarting(false);
      // Kept while the user decides whether to turn on encrypted backups.
      if (result !== 'consent-needed') setPassword('');
    }
  };

  const onCancelConsent = () => {
    cancelEncryptionConsent();
    setPassword('');
  };

  const pullLocked = phase === 'pulling' || encryptionConsent || starting;
  // Each pull writes into a new dated folder inside the one chosen (EPOCH-504),
  // so any chosen folder can take a pull.
  const askPassword = !!selectedDevice && !!destDir && phase !== 'pulling' && phase !== 'pulled';

  // The pull's own step rail, at the small size (board "iPhone Pull Flow"): each step's state, in order.
  const pullSteps4: Step[] = [
    { label: 'Device', state: selectedDevice ? 'done' : 'current' },
    {
      label: 'Destination',
      state: !selectedDevice ? 'pending' : destDir ? 'done' : 'current',
    },
    {
      label: 'Password',
      state: encryptionConsent ? 'done' : !askPassword ? 'pending' : passwordProvided ? 'done' : 'current',
    },
    {
      label: 'Start',
      state: askPassword && (passwordProvided || encryptionConsent) ? 'current' : 'pending',
    },
  ];

  if (!sourceId) return null;

  // Running: the Action Needed banner, then the running pull (board "iPhone Pull Flow").
  if (phase === 'pulling' && selectedDevice) {
    return (
      <div className="flex flex-col gap-4">
        {deviceAction && (
          <div
            role="alert"
            className="flex items-center gap-4 bg-warning/10 border border-warning/30 shadow-elevation-1 rounded-lg p-5"
          >
            <div className="p-3 rounded-full bg-warning/20 text-warning shrink-0">
              <Smartphone size="1.5rem" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-display text-heading text-warning">
                Action Needed on {selectedDevice?.name ?? 'the iPhone'}
              </h3>
              <p className="text-data text-foreground mt-1">{deviceAction}</p>
            </div>
            <Loader className="text-warning" />
          </div>
        )}
        <PullingCard
          device={selectedDevice}
          destShown={destShown}
          times={pullSteps}
          stats={pullStats}
          cancelling={cancelling}
          onCancel={cancelPull}
        />
      </div>
    );
  }

  // Finished: what was made, then the one next step (EPOCH-437).
  if (phase === 'pulled' && destDir) {
    return (
      <div className="flex flex-col gap-4">
        <PulledCard
          device={selectedDevice}
          times={pullSteps}
          stats={pullStats}
          crashReports={crashReports}
          savedShown={savedShown}
          onContinue={() => onBackupPulled(destDir)}
        />
        {/* EPOCH-519: a failed copy can be made again now, while the device is
         * connected, so the logs stay close in time to the backup. */}
        {crashReports && crashReports.outcome === 'failed' && (
          <div
            role="alert"
            className="flex items-center gap-4 bg-warning/10 border border-warning/30 shadow-elevation-1 rounded-lg p-5"
          >
            <div className="p-3 rounded-full bg-warning/20 text-warning shrink-0">
              <Smartphone size="1.25rem" />
            </div>
            <div className="flex-1 min-w-0 text-data">
              <h3 className="font-display text-heading text-warning">Crash Logs Could Not Be Copied</h3>
              <p className="text-foreground mt-1">
                The backup itself is complete and verified. Look at {selectedDevice?.name ?? 'the iPhone'}:{' '}
                {crashReports.locked ? 'it was locked. ' : ''}Unlock it, keep it connected, then copy its crash logs
                again. Without them, the report says crash logs were not acquired.
              </p>
              {crashReports.error && <p className="text-muted-foreground mt-1">{crashReports.error}</p>}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={copyCrashReportsAgain}
              loading={copyingCrashReports}
              className="shrink-0"
            >
              <RefreshCw size="0.875rem" />
              Copy Crash Logs Again
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="card rounded-xl p-6 flex flex-col gap-5">
      <div className="flex items-center gap-3">
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
        <p className="text-data text-muted-foreground flex items-center gap-2">
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
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 text-data text-warning bg-warning/10 border border-warning/30 shadow-elevation-1 p-4 rounded-xl">
            <XCircle size="1.125rem" className="shrink-0" />
            <span>iPhone import is not set up on this computer yet.</span>
          </div>

          {acquisitionError && (
            <div className="bg-danger/10 border border-danger/30 shadow-elevation-1 p-4 rounded-xl text-data text-danger">
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
            <div key={i} className="rounded-xl p-5 bg-surface-raised shadow-elevation-1">
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

              {action.kind === 'install-instructions' && (
                <div className="mt-4">
                  <div className="text-label text-muted-foreground mb-2 flex items-center gap-1.5">
                    <Terminal size="0.875rem" /> Terminal command (one-time setup)
                  </div>
                  <div className="flex flex-col gap-2">
                    {action.commands.map((c: string, j: number) => (
                      <div
                        key={j}
                        className="flex items-center justify-between gap-3 bg-inset shadow-elevation-1 rounded-lg px-4 py-3 font-mono text-data text-foreground/90"
                      >
                        <span className="truncate select-all">
                          <span className="text-accent select-none mr-2">$</span>
                          {c}
                        </span>
                        <CopyButton text={c} title="Copy command" />
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

          <div>
            <Button variant="outline" size="sm" onClick={checkAvailability}>
              <RefreshCw size="0.875rem" /> Check Again
            </Button>
          </div>
        </div>
      )}

      {/* The build's output is behind a closed disclosure (owner, 2026-10-18): it is not case material. */}
      {phase === 'acquiring' && (
        <div className="flex flex-col gap-3">
          <p className="text-data text-foreground flex items-center gap-2">
            <Loader className="text-accent" /> {acquisitionStep ?? 'Working…'}
          </p>
          <TerminalLog
            lines={acquisitionOutput.map((line) => ({ stream: 'stdout' as const, line }))}
            live
            label="Setup details"
          />
        </div>
      )}

      {phase === 'available' && toolStatus?.available && (
        <>
          {pullError && (
            <div
              role="alert"
              className={`flex items-start gap-4 rounded-xl p-5 shadow-elevation-1 border ${
                pullCancelled ? 'bg-warning/10 border-warning/30' : 'bg-danger/10 border-danger/30'
              }`}
            >
              <XCircle
                className={`shrink-0 mt-1 ${pullCancelled ? 'text-warning' : 'text-danger'}`}
                size="1.25rem"
                aria-hidden
              />
              <div className="flex-1 min-w-0 text-data">
                <p className={`font-medium ${pullCancelled ? 'text-warning' : 'text-danger'}`}>
                  {pullCancelled ? 'Pull Cancelled' : 'The Pull Failed'}
                </p>
                <p className="text-foreground mt-1">{pullError}</p>
              </div>
              <CopyButton
                label="Copy Details"
                title="Copy the error, the device's model and the pull's log"
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

          <StepList steps={pullSteps4} label="Pull steps" size="sm" className="" />

          {devices.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="p-3 rounded-xl bg-accent/10 text-accent">
                <Smartphone size="1.25rem" />
              </div>
              <p className="font-display text-heading text-foreground">No iPhone Found</p>
              <p className="text-data text-muted-foreground max-w-md">
                Connect it with a cable, unlock it, and tap Trust This Computer if the iPhone asks. Then check again.
              </p>
              <Button variant="outline" size="sm" onClick={checkAvailability}>
                <RefreshCw size="0.875rem" /> Check Again
              </Button>
            </div>
          ) : !selectedDevice ? (
            <div className="flex flex-col gap-3">
              <h3 className="text-label text-muted-foreground">Choose the iPhone to back up</h3>
              <div className="flex flex-col gap-3" role="radiogroup" aria-label="iPhone to back up">
                {devices.map((d) => (
                  <DeviceOption
                    key={d.id}
                    device={d}
                    selected={false}
                    disabled={pullLocked}
                    onChoose={() => onChooseDevice(d)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <>
              {/* Each finished choice folds into one line (board "iPhone Pull Flow"). */}
              <div className="bg-surface-raised rounded-lg shadow-elevation-1 px-4 py-3 flex flex-col gap-2 text-data">
                <p className="flex flex-wrap items-center gap-2">
                  <CheckCircle2 size="1rem" className="text-success shrink-0" aria-label="Chosen" />
                  <span className="text-foreground">{deviceTitle(selectedDevice)}</span>
                  <LinkButton onClick={() => onChooseDevice(null)} disabled={pullLocked}>
                    Change
                  </LinkButton>
                </p>
                {destDir ? (
                  <p className="flex flex-wrap items-center gap-2 min-w-0">
                    <CheckCircle2 size="1rem" className="text-success shrink-0" aria-label="Chosen" />
                    <span className="text-foreground">Save to</span>
                    <span className="font-mono text-foreground/80 truncate" title={destDir}>
                      {destShown}
                    </span>
                    <LinkButton onClick={onChooseDestination} disabled={pullLocked}>
                      Change…
                    </LinkButton>
                  </p>
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    {/* The current step's action is the primary button (DESIGN.md §9). */}
                    <Button size="sm" onClick={onChooseDestination} disabled={pullLocked}>
                      <FolderOpen size="0.875rem" /> Choose Destination
                    </Button>
                    <span className="text-muted-foreground">Choose where to save the backup.</span>
                  </div>
                )}
              </div>

              {askPassword && !encryptionConsent && (
                <div className="flex flex-col gap-3">
                  <div className="max-w-md">
                    <label htmlFor="pull-password" className="text-label text-foreground mb-1 flex items-center gap-2">
                      <Lock size="0.875rem" className="text-accent" /> Backup password (required)
                    </label>
                    <PasswordField
                      id="pull-password"
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
                    <p className="text-label text-muted-foreground mt-1">
                      Epoch makes encrypted backups only, because unencrypted ones leave out Keychain and Health data.
                      If this iPhone already makes encrypted backups, enter its backup password. Otherwise, this becomes
                      its backup password. It is not stored and never written to the Activity Log.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      onClick={() => onPullClick()}
                      disabled={!passwordProvided}
                      loading={starting}
                      loadingText="Starting…"
                      title={!passwordProvided ? 'Enter a backup password to continue' : undefined}
                    >
                      {pullError ? 'Pull Again' : 'Start Pull'}
                    </Button>
                    {pullError && (
                      <span className="text-label text-muted-foreground">
                        Pull Again starts from the beginning in a new folder. An incomplete one stays until you delete
                        it.
                      </span>
                    )}
                  </div>
                </div>
              )}

              {encryptionConsent && (
                <section className="rounded-lg bg-warning/10 border border-warning/30 shadow-elevation-1 p-5 flex flex-col gap-3">
                  <h3 className="flex items-center gap-2 font-display text-heading text-foreground">
                    <ShieldCheck size="1.125rem" className="text-warning" /> Turn On Encrypted Backups?
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
                    <Button onClick={() => onPullClick(true)} loading={starting} loadingText="Starting…">
                      <ShieldCheck size="1rem" /> Turn On and Continue
                    </Button>
                    <Button variant="outline" onClick={onCancelConsent} disabled={starting}>
                      Cancel
                    </Button>
                  </div>
                </section>
              )}

              {incomplete
                .filter((backup) => !setAside.includes(backup.path))
                // A leftover never blocks a pull: each pull gets a new folder (EPOCH-504).
                .map((backup) => (
                  <IncompleteBackupNotice
                    key={backup.path}
                    deviceName={deviceTitle(selectedDevice)}
                    incomplete={backup}
                    deleting={deletingIncomplete === backup.path}
                    onDelete={() => deleteIncomplete(backup)}
                    secondary={{ label: 'Not Now', onClick: () => setSetAside((prev) => [...prev, backup.path]) }}
                  />
                ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
