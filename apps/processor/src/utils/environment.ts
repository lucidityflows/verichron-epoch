import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * What a tool's Python environment contains, as its own interpreter reports
 * it: the Python version and every installed distribution with its version
 * (EPOCH-439). The digest is part of the tool's identity, so output made in a
 * different environment (pi-heif in place of pillow-heif, say) is never
 * recorded as made by the same tool. It describes what is installed, not what
 * a lockfile says should be.
 */
const LIST_ENVIRONMENT = [
  'import importlib.metadata as m, json, platform',
  'items = ["python==" + platform.python_version()]',
  'items += [d.metadata["Name"] + "==" + d.version for d in m.distributions()]',
  'print(json.dumps(items))',
].join('; ');

/** Lower-case, with runs of -, _ and . as one -, as Python packaging compares names. */
const canonicalName = (item: string) => {
  const [name, version] = item.split('==', 2);
  return `${name.toLowerCase().replace(/[-_.]+/g, '-')}==${version}`;
};

/** sha256 over the sorted list of the environment's contents. */
export function environmentDigest(items: string[]): string {
  const sorted = [...new Set(items.map(canonicalName))].sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}

/** How long listing an environment may take; it takes well under a second. */
export const ENVIRONMENT_TIMEOUT_MS = 60_000;

/**
 * The digest of the environment `python` runs in. Fails if it can't be read,
 * or isn't listed within `timeoutMs` (the interpreter is then killed): every
 * run records it, and nothing is processed until it has.
 */
export async function pythonEnvironmentDigest(python: string, timeoutMs = ENVIRONMENT_TIMEOUT_MS): Promise<string> {
  const output = await new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    const child = spawn(python, ['-I', '-c', LIST_ENVIRONMENT], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`it did not answer within ${Math.round(timeoutMs / 1000)} s and was stopped`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit code ${code}${err.trim() ? `: ${err.trim()}` : ''}`));
    });
  }).catch((error: unknown) => {
    throw new Error(
      `could not list the Python environment of ${python} (${error instanceof Error ? error.message : error}); ` +
        "every run records its tools' environments"
    );
  });
  let items: unknown;
  try {
    items = JSON.parse(output);
  } catch {
    items = null;
  }
  if (!Array.isArray(items) || items.length === 0 || !items.every((i) => typeof i === 'string' && i.includes('=='))) {
    throw new Error(`${python} listed its environment in an unexpected form: ${output.trim().slice(0, 200)}`);
  }
  return environmentDigest(items as string[]);
}
