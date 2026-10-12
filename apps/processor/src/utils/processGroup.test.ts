/**
 * EPOCH-486: a stop sent to the processor reaches the detached process groups
 * it started. Run in a child process, since the signal ends the process that
 * receives it.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'process-group-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('trackProcessGroup (EPOCH-486)', () => {
  it('forwards SIGTERM to a tracked group, then ends the processor as the signal would', async () => {
    const pidFile = path.join(tmp, 'tool.pid');
    const script = path.join(tmp, 'runner.mts');
    const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'processGroup.ts');
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { trackProcessGroup } from ${JSON.stringify(helper)};
const tool = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
trackProcessGroup(tool.pid);
writeFileSync(${JSON.stringify(pidFile)}, String(tool.pid));
setInterval(() => {}, 1000);
`
    );
    const runner = spawn(process.execPath, ['--import', 'tsx', script], { stdio: 'ignore' });
    let toolPid = 0;
    for (let i = 0; i < 100 && !toolPid; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        toolPid = Number(readFileSync(pidFile, 'utf8'));
      } catch {
        // not written yet
      }
    }
    assert.ok(toolPid > 0, 'the runner started its tool');
    assert.ok(alive(toolPid));

    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      runner.on('exit', (_code, signal) => resolve(signal))
    );
    runner.kill('SIGTERM');
    assert.equal(await exited, 'SIGTERM', 'the processor ended as SIGTERM ends it');
    for (let i = 0; i < 50 && alive(toolPid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(toolPid), false, "the tool's group was stopped too");
  });
});
