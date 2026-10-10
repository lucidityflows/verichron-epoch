/**
 * Core interfaces for pulling a forensic backup directly from a connected
 * device, as an alternative entry point to WorkspaceView's existing
 * "select an existing backup directory" flow.
 *
 * Two concerns are deliberately kept separate here, because they vary
 * independently:
 *
 *   DeviceBackupSource    -- how to talk to a *kind* of device (iOS via
 *                             idevicebackup2 today; Android via adb, or
 *                             anything else, later). Each implementation
 *                             is a self-contained plugin behind this one
 *                             interface.
 *
 *   ToolAcquisitionStrategy -- how to get the underlying CLI tool onto
 *                             *this* machine for *this* platform. An iOS
 *                             source on Linux needs a completely different
 *                             acquisition story (detect a self-compiled
 *                             binary, or walk the user through compiling
 *                             one) than the same iOS source on Windows
 *                             (bundle one, or download a verified release).
 *                             A future Android source likely needs no
 *                             acquisition step at all -- adb ships with
 *                             most dev environments already.
 *
 * If these two were merged into one interface (as the original scaffolding
 * did, with download/verify/install logic baked directly into the device
 * class), adding a second device kind would mean reworking both at once
 * instead of just writing a new DeviceBackupSource against the existing
 * ToolAcquisitionStrategy contract.
 */

export interface DeviceInfo {
  /** Stable identifier for this device (UDID for iOS). */
  id: string;
  /** Human-readable name, e.g. "Robert's iPhone". */
  name: string;
  /** Free-form model/product string, e.g. "iPhone14,2". Source-specific. */
  model?: string;
  /** OS version string if the source can report one, e.g. "17.5.1". */
  osVersion?: string;
}

export type ToolAvailabilityStatus =
  | { available: true; path: string }
  | { available: false; reason: string };

/** `device-action`: the pull is waiting for the user to do something on the device. */
export type BackupProgressPhase = 'preparing' | 'device-action' | 'transferring' | 'verifying' | 'done' | 'error';

export interface BackupProgress {
  phase: BackupProgressPhase;
  /** 0-100 when known; omit when the underlying tool gives no percentage. */
  percent?: number;
  /** Short human-readable status line, safe to show directly in the UI. */
  message: string;
}

export interface PullOptions {
  /** The backup password: the device's existing one, or the new one when encryption is turned on. */
  password: string;
  /** The user agreed to turn on the device's encrypted backups if they're off (EPOCH-466). */
  enableEncryption: boolean;
}

export interface DeviceBackupSource {
  readonly id: string;
  readonly label: string;
  checkToolAvailable(): Promise<ToolAvailabilityStatus>;
  listConnectedDevices(): Promise<DeviceInfo[]>;
  /** Whether the device makes encrypted backups; throws when it can't be read. */
  backupEncryptionEnabled(device: DeviceInfo): Promise<boolean>;
  pullBackup(
    device: DeviceInfo,
    destDir: string,
    onProgress: (progress: BackupProgress) => void,
    options: PullOptions
  ): Promise<string>;
}

export type ToolAcquisitionAction =
  | { kind: 'install-instructions'; title: string; commands: string[] }
  | { kind: 'compile-from-source'; title: string; steps: ToolAcquisitionCommand[] }
  | { kind: 'download-verified-release'; title: string; manifestUrl: string };

/** Result of running a (Windows) acquisition action. */
export interface ToolAcquisitionResult {
  success: boolean;
  failedStep?: string;
}

export interface ToolAcquisitionCommand {
  /** Short label shown above this step in the UI, e.g. "Install build
   * dependencies". Never shown as a raw command -- the app runs it and
   * streams output through a glossier presentation, not a terminal. */
  label: string;
  command: string;
  args: string[];
  /** Working directory relative to a per-run temp build dir the app
   * manages; undefined means the build dir root itself. */
  cwd?: string;
}

export interface ToolAcquisitionStrategy {
  /** Guided setup, where this platform supports it (EPOCH-465). */
  guided?: GuidedToolSetup;
  /** What can this platform actually do to get the tool installed? Returns
   * every viable action so the UI can offer a choice (e.g. Linux: compile
   * from source, only option; Windows: bundled binary check, or a verified
   * download) rather than this layer picking one on the caller's behalf. */
  availableActions(): ToolAcquisitionAction[];
}

/* ---------------------------------------------------------------------------
 * Guided tool setup (EPOCH-465): what a source needs on this machine, whether
 * each requirement is met, and a step-by-step install with structured
 * progress. Linux and macOS; Windows keeps ToolAcquisitionAction.
 * ------------------------------------------------------------------------- */

export type ToolSetupGroup = 'system' | 'service' | 'libraries';

export interface ToolSetupRequirement {
  id: string;
  group: ToolSetupGroup;
  /** A name, e.g. "pkg-config" or "libplist 2.8.0". */
  label: string;
  ok: boolean;
  /** The installed version when known. */
  version?: string;
  /** One sentence: what it's for, or why it isn't met. */
  detail?: string;
}

export interface ToolSetupInstallPlan {
  /** The packages that would be installed. */
  packages: string[];
  /** The exact command, for the user to read or copy. */
  command: string;
  /** True when the app can run it itself (through the OS's admin prompt where needed). */
  automatic: boolean;
  /** Anything the user should know first, e.g. "Epoch will ask for your administrator password." */
  note?: string;
}

export interface ToolSetupStatus {
  /** Guided setup is available on this platform. */
  supported: boolean;
  requirements: ToolSetupRequirement[];
  /** Every system and service requirement is met, so the libraries can be built. */
  systemReady: boolean;
  /** The libraries are installed at the pinned versions and verified. */
  installed: boolean;
  /** How to install what's missing from the system, or null when nothing is. */
  install: ToolSetupInstallPlan | null;
  /** A previous build stopped part-way and can resume. */
  canResume: boolean;
  /** Why guided setup isn't available, when `supported` is false. */
  unsupportedReason?: string;
}

export type ToolSetupStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface ToolSetupStep {
  id: string;
  label: string;
  status: ToolSetupStepStatus;
  /** The current phase of a running step, e.g. "Configuring", or why it was skipped. */
  detail?: string;
}

export type ToolSetupEvent =
  | { type: 'plan'; steps: ToolSetupStep[] }
  | { type: 'step'; id: string; status: ToolSetupStepStatus; detail?: string }
  | { type: 'output'; id: string; line: string };

export interface ToolSetupFailure {
  stepId: string;
  /** What failed, as a name: "Configure libplist 2.8.0". */
  label: string;
  /** A plain-language cause when the output shows one. */
  hint?: string;
  /** The last lines of the failed command's output. */
  tail: string[];
}

export interface ToolSetupResult {
  success: boolean;
  failure?: ToolSetupFailure;
  /** Something to do next, e.g. finishing Apple's installer. */
  note?: string;
}

/** Implemented by an acquisition strategy that offers guided setup. */
export interface GuidedToolSetup {
  status(): Promise<ToolSetupStatus>;
  installRequirements(emit: (event: ToolSetupEvent) => void): Promise<ToolSetupResult>;
  build(emit: (event: ToolSetupEvent) => void): Promise<ToolSetupResult>;
}
