import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    // 店内LANの実機（iPad 等）から開発サーバーに接続できるようにする
    host: true,
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/socket.io': { target: apiTarget, ws: true },
    },
  },
  build: {
    outDir: 'dist',
  },
});
