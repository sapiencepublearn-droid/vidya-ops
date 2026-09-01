import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    port: 5173,
    // The app calls /api/... so the browser origin and API origin match
    // in development. No CORS, and no API URL baked into the bundle.
    proxy: { '/api': { target: process.env.API_URL || 'http://localhost:3000', changeOrigin: true } },
  },
  build: { outDir: '../dist', emptyOutDir: true },
});
