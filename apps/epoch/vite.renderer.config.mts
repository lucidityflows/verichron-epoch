import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  root: '.',
  build: {
    rollupOptions: {
      input: {
        main_window: path.resolve(__dirname, 'index.html'),
      },
    },
  },
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
