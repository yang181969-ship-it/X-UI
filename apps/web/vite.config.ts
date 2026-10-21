import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on IPv4 loopback explicitly: 'localhost' binds only ::1 on some Windows setups,
    // where IPv6 loopback isn't reachable. Still open http://localhost:5173 for passkeys
    // (RP_ID=localhost; an IP address can't be a WebAuthn RP ID).
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787' },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
  },
});
