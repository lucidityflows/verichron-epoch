import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    lib: {
      entry: 'src/main/main.ts',
      formats: ['cjs'],
      fileName: () => 'main.js', // forces exact output filename
    },
    rollupOptions: {
      // @verichron/etl-db-reader is a CJS workspace package (compiled via
      // tsc, not Vite/Rollup) whose re-exports use TypeScript's
      // Object.defineProperty getter pattern. Rollup can't statically
      // analyze that as ESM named exports, so bundling it fails with
      // "X is not exported by ...". The main process runs in Node and
      // can require() workspace packages natively at runtime, so treat
      // it as external instead of trying to bundle it.
      //
      // pg is a Node-native DB driver with its own internal dynamic
      // require() calls (e.g. for optional native bindings). Rollup's
      // CJS-to-ESM interop wraps it in a self-referencing "augmented
      // namespace" object, which throws "Cannot access 'pg' before
      // initialization" at runtime — a circular-binding TDZ error, not
      // a real code bug. Like db-reader, this is meant to be
      // require()'d natively by the main process, not bundled.
      // @verichron/contracts is built the same way (tsc, same getter
      // re-export pattern) and hits the identical Rollup limitation --
      // same fix, same reason.
      //
      // builtinModules (path, fs, child_process, crypto, ...) covers
      // every Node core module regardless of whether the importing file
      // used a bare specifier ('child_process') or the node: prefix
      // ('node:child_process') -- the /^node:.+/ regex this list used to
      // rely on alone only matched the latter, so any main-process file
      // written with a bare specifier (most of this codebase) silently
      // broke the build the moment Rollup tried to bundle it as if it
      // were a real npm package.
      external: [
        '@verichron/etl-db-reader',
        '@verichron/contracts',
        'pg',
        'electron',
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
    },
  },
});
