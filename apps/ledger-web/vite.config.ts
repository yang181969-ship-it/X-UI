import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** X-UI v1 web: port 5174, API proxy to the v1 API on 8788 (never the legacy 8787). */
export const WEB_PORT = 5174;
export const API_PORT = 8788;

export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on IPv4 loopback explicitly: 'localhost' binds only ::1 on some Windows setups,
    // where IPv6 loopback isn't reachable. Still open http://localhost:5174 in the browser for
    // passkeys and the Origin check (XUI_V1_RP_ID=localhost; an IP address is refused).
    host: '127.0.0.1',
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}` },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
  },
});
