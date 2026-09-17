import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone app (2026-09-17) -- deliberately separate from control-panel
// (:5173) so a bug here can never crash the tournament-running UI, and so
// this can later run on its own small device (see CLAUDE.md's "Machine
// Diagnostics" section) without dragging in the tournament app.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
