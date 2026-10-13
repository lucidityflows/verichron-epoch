import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DerivativeKind } from '@verichron/contracts';
import { StageDefinition, StageManifest, StageSet } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '../../..');
const EXTRACTORS_DIR = path.join(REPO_ROOT, 'apps', 'extractors');
const REPORTING_DIR = path.join(REPO_ROOT, 'apps', 'reporting');

/** Every key stage-manifest.schema.json allows; it sets additionalProperties: false. */
const MANIFEST_KEYS = new Set(['$schema', 'entrypoint', 'runtime', 'order', 'reads', 'parserVersion', 'enabled']);

export function isStageManifest(value: unknown): value is StageManifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).every((key) => MANIFEST_KEYS.has(key)) &&
    typeof v.entrypoint === 'string' &&
    (v.runtime === 'python' || v.runtime === 'node') &&
    typeof v.order === 'number' &&
    DerivativeKind.safeParse(v.reads).success &&
    (v.parserVersion === undefined ||
      (typeof v.parserVersion === 'number' && Number.isInteger(v.parserVersion) && v.parserVersion >= 1)) &&
    typeof v.enabled === 'boolean'
  );
}

async function loadStageFromDir(dir: string, name: string): Promise<StageDefinition | null> {
  const manifestPath = path.join(dir, 'stage.json');
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, 'utf-8');
  } catch {
    console.warn(`[orchestrator] ${dir} has no stage.json — skipping, not treated as a stage.`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[orchestrator] ${manifestPath} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isStageManifest(parsed)) {
    throw new Error(
      `[orchestrator] ${manifestPath} does not match stage-manifest.schema.json ` +
        `(no other keys; need entrypoint: string, runtime: "python"|"node", order: number, ` +
        `reads: ${DerivativeKind.options.map((k) => `"${k}"`).join('|')}, enabled: boolean, ` +
        `optional parserVersion: integer >= 1).`
    );
  }

  const entrypointPath = path.join(dir, parsed.entrypoint);
  const entrypointExists = await fsp
    .access(entrypointPath)
    .then(() => true)
    .catch(() => false);
  if (!entrypointExists) {
    throw new Error(
      `[orchestrator] ${manifestPath} declares entrypoint "${parsed.entrypoint}" but ${entrypointPath} does not exist.`
    );
  }

  return { name, dir, manifest: parsed };
}

export async function discoverStages(): Promise<StageSet> {
  const extractorEntries = await fsp.readdir(EXTRACTORS_DIR, { withFileTypes: true });
  const candidateDirs = extractorEntries
    .filter((e) => e.isDirectory())
    .map((e) => ({ dir: path.join(EXTRACTORS_DIR, e.name), name: e.name }));
  // apps/analysis (the AI stage) is not a stage until EPOCH-442 re-points it
  // at the project's own facts; its only input was removed (EPOCH-489).
  candidateDirs.push({ dir: REPORTING_DIR, name: path.basename(REPORTING_DIR) });

  const loaded = await Promise.all(candidateDirs.map((c) => loadStageFromDir(c.dir, c.name)));
  const found = loaded.filter((s): s is StageDefinition => s !== null);
  const stages = found.filter((s) => s.manifest.enabled);
  const disabled = found.filter((s) => !s.manifest.enabled);

  const orderCounts = new Map<number, string[]>();
  for (const s of stages) {
    orderCounts.set(s.manifest.order, [...(orderCounts.get(s.manifest.order) ?? []), s.name]);
  }
  for (const [order, names] of orderCounts) {
    if (names.length > 1) {
      throw new Error(
        `[orchestrator] stages ${names.join(', ')} all declare order ${order} — orders must be unique among enabled stages.`
      );
    }
  }

  const reportStage = stages.find((s) => s.dir === REPORTING_DIR);
  const maxExtractorOrder = Math.max(0, ...stages.filter((s) => s.dir !== REPORTING_DIR).map((s) => s.manifest.order));
  if (reportStage && reportStage.manifest.order <= maxExtractorOrder) {
    throw new Error(
      `[orchestrator] apps/reporting/stage.json declares order ${reportStage.manifest.order}, ` +
        `which is not after every extractor stage (max ${maxExtractorOrder}). Reporting must run last.`
    );
  }

  stages.sort((a, b) => a.manifest.order - b.manifest.order);
  console.log(
    `[orchestrator] discovered ${stages.length} enabled stage(s): ${stages.map((s) => `${s.name}(${s.manifest.order})`).join(', ')}`
  );
  if (disabled.length > 0) {
    console.log(
      `[orchestrator] ${disabled.length} disabled stage(s), recorded as skipped: ${disabled.map((s) => s.name).join(', ')}`
    );
  }
  return { enabled: stages, disabled };
}
