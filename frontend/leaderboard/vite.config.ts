import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // './' base is required so asset paths are relative when Electron loads
  // dist/index.html via file:// protocol. Dev server still uses '/' implicitly.
  base: command === 'serve' ? '/' : './',
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
}));
