import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Dev only: the host still enforces its LAN rules; xfwd passes the real device address through the proxy.
export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', proxy: { '/api': { target: 'http://127.0.0.1:4174', xfwd: true } } },
  // Vendor chunks change rarely, so Mac/iPad browsers keep them cached across Atlas updates.
  build: { chunkSizeWarningLimit: 1100, rollupOptions: { output: { manualChunks: { maplibre: ['maplibre-gl'], flow: ['@xyflow/react']} } } },
});
