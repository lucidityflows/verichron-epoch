import * as fsp from 'node:fs/promises';
import { log } from './events.js';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ErrorObject } from 'ajv';
import { StageDefinition, StageManifest, StageSet } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Where discovery looks for stages: every directory under `extractors`, and `reporting`. */
export interface StageRoots {
  extractorsDir: string;
  reportingDir: string;
}

const REPO_ROOTS: StageRoots = {
  extractorsDir: path.join(REPO_ROOT, 'apps', 'extractors'),
  reportingDir: path.join(REPO_ROOT, 'apps', 'reporting'),
};

/**
 * The one definition of a valid stage.json is the schema itself (EPOCH-444):
 * compiled once, so a new field is added in one place and a misspelled one is
 * refused (the schema sets additionalProperties: false).
 */
const SCHEMA_PATH = path.join(REPO_ROOT, 'packages', 'contracts', 'stage-manifest.schema.json');
const validate = new Ajv({ allErrors: true }).compile<StageManifest>(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));

/** Each failing field, as the schema validator reports it. */
function describeErrors(errors: ErrorObject[]): string {
  return errors
    .map((e) => {
      const where = e.instancePath ? e.instancePath.slice(1) : '(top level)';
      if (e.keyword === 'additionalProperties') {
        return `"${(e.params as { additionalProperty: string }).additionalProperty}" is not a stage.json field`;
      }
      if (e.keyword === 'enum') {
        return `${where} ${e.message}: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(', ')}`;
      }
      return `${where} ${e.message}`;
    })
    .join('; ');
}

/** The manifest, once it matches stage-manifest.schema.json; otherwise an error naming the file and each field. */
export function validateManifest(value: unknown, manifestPath: string): StageManifest {
  if (validate(value)) return value;
  throw new Error(
    `[orchestrator] ${manifestPath} does not match stage-manifest.schema.json: ${describeErrors(validate.errors ?? [])}`
  );
}

async function loadStageFromDir(dir: string, name: string): Promise<StageDefinition | null> {
  const manifestPath = path.join(dir, 'stage.json');
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, 'utf-8');
  } catch {
    log('warn', `${path.relative(REPO_ROOT, dir)} has no stage.json — skipping, not treated as a stage.`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[orchestrator] ${manifestPath} is not valid JSON: ${(err as Error).message}`);
  }
  const manifest = validateManifest(parsed, manifestPath);

  const entrypointPath = path.join(dir, manifest.entrypoint);
  const entrypointExists = await fsp
    .access(entrypointPath)
    .then(() => true)
    .catch(() => false);
  if (!entrypointExists) {
    throw new Error(
      `[orchestrator] ${manifestPath} declares entrypoint "${manifest.entrypoint}" but ${entrypointPath} does not exist.`
    );
  }

  return { name, dir, manifest };
}

export async function discoverStages(roots: StageRoots = REPO_ROOTS): Promise<StageSet> {
  const { extractorsDir, reportingDir } = roots;
  const extractorEntries = await fsp.readdir(extractorsDir, { withFileTypes: true });
  const candidateDirs = extractorEntries
    .filter((e) => e.isDirectory())
    .map((e) => ({ dir: path.join(extractorsDir, e.name), name: e.name }));
  // apps/analysis (the AI stage) is not a stage until EPOCH-442 re-points it
  // at the project's own facts; its only input was removed (EPOCH-489).
  candidateDirs.push({ dir: reportingDir, name: path.basename(reportingDir) });

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

  const reportStage = stages.find((s) => s.dir === reportingDir);
  const maxExtractorOrder = Math.max(0, ...stages.filter((s) => s.dir !== reportingDir).map((s) => s.manifest.order));
  if (reportStage && reportStage.manifest.order <= maxExtractorOrder) {
    throw new Error(
      `[orchestrator] apps/reporting/stage.json declares order ${reportStage.manifest.order}, ` +
        `which is not after every extractor stage (max ${maxExtractorOrder}). Reporting must run last.`
    );
  }

  stages.sort((a, b) => a.manifest.order - b.manifest.order);
  log(
    'debug',
    `discovered ${stages.length} enabled stage(s): ${stages.map((s) => `${s.name}(${s.manifest.order})`).join(', ')}`
  );
  if (disabled.length > 0) {
    log('info', `${disabled.length} disabled stage(s), recorded as skipped: ${disabled.map((s) => s.name).join(', ')}`);
  }
  return { enabled: stages, disabled };
}
