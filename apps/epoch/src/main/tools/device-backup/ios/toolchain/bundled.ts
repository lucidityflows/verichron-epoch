import fs from 'fs';
import path from 'path';
import type {
  GuidedToolSetup,
  ToolAvailabilityStatus,
  ToolSetupRequirement,
  ToolSetupResult,
  ToolSetupStatus,
} from '../../../../../shared/types/tools';
import { serviceRequirements, type SetupContext } from './requirements';
import { run as defaultRun } from './process';

/** The tools a pull runs (iosBackupSource.ts), all of them in the Lab bundle's bin/. */
export const BUNDLED_TOOLS = ['idevicebackup2', 'idevicecrashreport', 'idevice_id', 'ideviceinfo'] as const;

/** Where Debian's usbmuxd package installs its udev rules (usbmuxd 1.1.1, Debian 13). */
export const USBMUXD_UDEV_RULES = '/usr/lib/udev/rules.d/39-usbmuxd.rules';

/** In the Lab bundle the tools are never installed by the app, only found. */
const NOT_IN_LAB = 'The Lab build installs nothing: its iPhone tools are part of the bundle.';

/** Supplies the running host's platform, process runner, file lookup and environment for Lab checks. */
export function defaultBundledContext(): Pick<SetupContext, 'platform' | 'run' | 'exists' | 'env'> {
  return {
    platform: process.platform,
    run: defaultRun,
    exists: (file: string) => fs.existsSync(file),
    env: process.env,
  };
}

/**
 * iPhone import in the Lab bundle (EPOCH-472). The tools ship prebuilt in the
 * bundle's bin/, so there is nothing to download or build, and no guided setup.
 * What remains are the host steps that need an administrator: the usbmuxd
 * service and its udev rules, installed from the lab's own package media. The
 * status lists them, with the command, and offers no install: the Lab build
 * makes no network connection.
 */
export function bundledSetup(
  bin: string,
  ctx: Pick<SetupContext, 'platform' | 'run' | 'exists' | 'env'> = defaultBundledContext()
): GuidedToolSetup {
  /** Lists bundled tools and host requirements, with manual installation guidance for missing host steps. */
  const status = async (): Promise<ToolSetupStatus> => {
    const service = await serviceRequirements(ctx as SetupContext, ctx.env);
    const udev: ToolSetupRequirement = {
      id: 'udev-rules',
      group: 'service',
      label: 'usbmuxd udev rules',
      ok: ctx.exists(USBMUXD_UDEV_RULES),
      detail: ctx.exists(USBMUXD_UDEV_RULES)
        ? 'Start usbmuxd when an iPhone is plugged in.'
        : 'Not installed. They come with the usbmuxd package.',
    };
    const tools: ToolSetupRequirement[] = BUNDLED_TOOLS.map((tool) => {
      const ok = ctx.exists(path.join(bin, tool));
      return {
        id: tool,
        group: 'libraries',
        label: tool,
        ok,
        detail: ok ? 'In the Lab bundle.' : 'Missing from the bundle, so the bundle is incomplete.',
      };
    });
    const systemReady = [...service, udev].every((r) => r.ok);
    const installed = tools.every((r) => r.ok);
    return {
      // There is no setup to run: a bundle missing a tool is incomplete, not unbuilt.
      supported: installed,
      unsupportedReason: installed ? undefined : 'The Lab bundle is missing an iPhone tool, so it is incomplete.',
      requirements: [...service, udev, ...tools],
      systemReady,
      installed,
      install: systemReady
        ? null
        : {
            packages: ['usbmuxd'],
            command: 'sudo apt install usbmuxd',
            automatic: false,
            note: "An administrator installs it from the lab's own package media; Epoch makes no network connection.",
          },
      canResume: false,
    };
  };
  /** Rejects install and build requests because the Lab bundle supplies prebuilt tools. */
  const refuse = async (): Promise<ToolSetupResult> => {
    throw new Error(NOT_IN_LAB);
  };
  return { status, installRequirements: refuse, build: refuse };
}

/**
 * Whether a pull may start in the Lab bundle: every tool a pull runs is in the
 * bundle, and both host steps are met. Otherwise unavailable, naming what is
 * not, so the app shows the checklist (with the administrator's command)
 * instead of the device picker, and no pull starts without a tool it needs.
 */
export function labAvailability(status: ToolSetupStatus, bin: string): ToolAvailabilityStatus {
  const unmet = status.requirements.filter((r) => !r.ok).map((r) => r.label);
  if (unmet.length > 0) return { available: false, reason: `Not ready for iPhone import: ${unmet.join(', ')}.` };
  return { available: true, path: path.join(bin, 'idevicebackup2') };
}

/** Probes the Lab setup and returns the backup tool's path or names unmet requirements. */
export async function bundledAvailability(
  bin: string,
  ctx: Pick<SetupContext, 'platform' | 'run' | 'exists' | 'env'> = defaultBundledContext()
): Promise<ToolAvailabilityStatus> {
  const setup = bundledSetup(bin, ctx);
  const status = await setup.status();
  return labAvailability(status, bin);
}
