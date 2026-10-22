// Compile the orchestrator, the processor and the database server into one
// file each, for the Lab bundle's Node (EPOCH-478, EPOCH-477):
// node tools/services/compile.mjs <bundle>/services
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/services/compile.mjs <output directory>');
  process.exit(2);
}

for (const service of ['orchestrator', 'processor', 'dbserver']) {
  await build({
    entryPoints: [path.join(root, 'apps', service, 'src', 'main.ts')],
    outfile: path.join(out, `${service}.mjs`),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    // CommonJS code inlined here (our contracts, pg) uses require and __dirname;
    // in one ES module they are this file's own, so the layout is found from
    // services/ (layout.ts).
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        "import { fileURLToPath as __fileURLToPath } from 'node:url';",
        "import { dirname as __pathDirname } from 'node:path';",
        'const require = __createRequire(import.meta.url);',
        'const __filename = __fileURLToPath(import.meta.url);',
        'const __dirname = __pathDirname(__filename);',
      ].join('\n'),
    },
    // pg loads its optional native binding only when asked for it; it isn't installed.
    external: ['pg-native'],
    // The bundled packages' licence comments go beside each file (<name>.mjs.LEGAL.txt), for the notices (EPOCH-535).
    legalComments: 'external',
    logLevel: 'warning',
  });
  console.log(`[services] ${path.join(out, `${service}.mjs`)}`);
}
