/**
 * Public entry point for `@verichron/contracts`.
 *
 * `epoch` and `@verichron/etl-db-writer` both declare a dependency on this
 * package, and its package.json has always pointed `main` at `dist/index.js`.
 * TypeScript consumers validate with the Zod model exported here.
 *
 * The canonical JSON Schema (`normalized-record.schema.json`, a sibling of
 * this file) is deliberately not re-exported through TypeScript: importing
 * JSON from outside this package's rootDir fights `composite`/`outDir`
 * emit, and Zod already gives TS callers the same guarantee. Python callers
 * that want raw JSON Schema validation use `adapter.py` in this same
 * directory.
 */

export { NormalizedRecord } from "./ts/normalizedRecord.js";
export { discoverBackups, BACKUP_SEARCH_MAX_DEPTH } from "./ts/discoverBackups.js";
export type { Backup } from "./ts/discoverBackups.js";
export { deriveResultsPath } from './ts/deriveResultsPath.js';
export { deriveEvidencePath } from './ts/deriveEvidencePath.js';
export { EvidenceSidecar } from './ts/evidenceSidecar.js';
export { SourceType, isSourceType } from './ts/sourceType'
export type { SourceType as SourceTypeValue } from './ts/sourceType'
export { loadRootEnv, resolveDatabaseUrl } from './ts/env.js';