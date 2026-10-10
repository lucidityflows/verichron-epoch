import type { ToolSetupEvent, ToolSetupResult } from '../../../../../shared/types/tools';
import { adminPromptHint, hintFor } from './hints';
import { lastLines } from './process';
import { APT_PACKAGES, BREW_FORMULAS, brewPrefixOf, checkRequirements, toolchainEnv, type SetupContext } from './requirements';

const STEP = 'system';

/**
 * Installs the missing system requirements (EPOCH-465): on Debian/Ubuntu
 * through pkexec, the desktop's own administrator prompt, as one command so
 * the user is asked once; on macOS through Apple's Command Line Tools
 * installer or Homebrew, which need no administrator rights. The checklist is
 * re-read afterwards by the caller.
 */
export async function installSystemRequirements(
  ctx: SetupContext,
  emit: (event: ToolSetupEvent) => void
): Promise<ToolSetupResult> {
  const status = await checkRequirements(ctx);
  const plan = status.install;
  if (!plan) return { success: true };
  const label = `Install ${plan.packages.join(', ')}`;
  if (!plan.automatic) {
    return { success: false, failure: { stepId: STEP, label, hint: plan.note, tail: [] } };
  }

  emit({ type: 'plan', steps: [{ id: STEP, label, status: 'pending' }] });
  emit({ type: 'step', id: STEP, status: 'running', detail: 'Waiting for administrator approval' });
  const onOutput = (text: string) => {
    for (const line of text.split('\n')) if (line.trim()) emit({ type: 'output', id: STEP, line });
    emit({ type: 'step', id: STEP, status: 'running', detail: 'Installing' });
  };

  let env = toolchainEnv(ctx);
  let command: string;
  let args: string[];
  let note: string | undefined;
  if (ctx.platform === 'darwin') {
    env = toolchainEnv(ctx, await brewPrefixOf(ctx, env));
    if (plan.packages[0] === 'Xcode Command Line Tools') {
      [command, args] = ['xcode-select', ['--install']];
      note = plan.note;
    } else {
      [command, args] = ['brew', ['install', ...BREW_FORMULAS]];
    }
  } else {
    command = 'pkexec';
    args = [
      'env',
      'DEBIAN_FRONTEND=noninteractive',
      'sh',
      '-c',
      `apt-get update && apt-get install -y ${APT_PACKAGES.join(' ')}`,
    ];
  }

  const result = await ctx.run(command, args, { env, onOutput });
  if (result.code !== 0) {
    const tail = lastLines(result.output);
    emit({ type: 'step', id: STEP, status: 'failed' });
    const hint = (command === 'pkexec' ? adminPromptHint(result.code) : undefined) ?? hintFor(tail);
    return { success: false, failure: { stepId: STEP, label, hint, tail } };
  }
  emit({ type: 'step', id: STEP, status: 'done' });
  return { success: true, note };
}
