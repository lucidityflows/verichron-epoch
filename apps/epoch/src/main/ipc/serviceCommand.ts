import path from 'path';
import type { Layout } from '@verichron/contracts';

export type Service = 'orchestrator' | 'processor' | 'dbserver';

export interface ServiceCommand {
  command: string;
  args: string[];
  cwd: string;
}

/** The pnpm script each service runs from in a checkout; the database server is the bundle's alone (EPOCH-477). */
const SCRIPT: Partial<Record<Service, string>> = { orchestrator: 'investigate', processor: 'dev' };

/**
 * How the app starts a service (EPOCH-478; docs/architecture.md, "The Lab
 * bundle"). In a checkout, through pnpm, as development runs it; `--silent`,
 * because pnpm's script banners would print the repository's path
 * (docs/event-log.md §6.6). In the Lab bundle, the compiled service with the
 * bundled Node: no pnpm, no TypeScript, no PATH lookup.
 */
export function serviceCommand(lay: Layout, service: Service, args: string[]): ServiceCommand {
  if (lay.kind === 'bundle') {
    return {
      command: path.join(lay.root, 'node', 'bin', 'node'),
      args: [path.join(lay.root, 'services', `${service}.mjs`), ...args],
      cwd: lay.root,
    };
  }
  const script = SCRIPT[service];
  if (!script) throw new Error(`the ${service} service runs only in the Lab bundle`);
  return {
    command: 'pnpm',
    args: ['--silent', '--filter', `@verichron/${service}`, script, '--', ...args],
    cwd: lay.root,
  };
}
