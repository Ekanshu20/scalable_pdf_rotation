import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Builds into ../backend/static/dist, which FastAPI serves. The build runs in CI or
// locally and only the output ships — no Node in the runtime image, so an
// air-gapped deployment is unaffected.
export default defineConfig({
  plugins: [react()],
  base: '/static/dist/',
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    outDir: path.resolve(__dirname, '../backend/static/dist'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
});
