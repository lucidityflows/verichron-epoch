import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/preload/preload.ts',
      formats: ['cjs'],
      fileName: 'preload',
    },
    rollupOptions: {
      external: ['electron', '@verichron/contracts', '@verichron/etl-db-reader', 'pg', /^node:.+/],
    },
  },
});
