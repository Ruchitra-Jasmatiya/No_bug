import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on :4000 and is reached through this proxy, so the refresh cookie is same-origin.
// In production Vercel rewrites /api/* to the API (see vercel.json), which keeps the cookie same-origin there too.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: process.env.VITE_DEV_API ?? 'http://localhost:4000', changeOrigin: false } } },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom', 'react-router-dom'], motion: ['framer-motion'] } } },
  },
});
