import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// EPOCH-454: one runner for the app. Main-process tests run in Node; renderer
// tests run in jsdom with Testing Library. Forks rather than worker threads,
// because several main-process tests spawn stub executables.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    environmentMatchGlobs: [['src/renderer/**', 'jsdom']],
    pool: 'forks',
    // The settings a renderer view reads, loaded as SettingsGate loads them in the app (EPOCH-560).
    setupFiles: ['src/renderer/test/settings.ts'],
  },
});
