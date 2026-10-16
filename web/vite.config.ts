import { fileURLToPath } from 'node:url';
import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const apiTarget = process.env.PI_DOCUMENT_API_TARGET ?? 'http://127.0.0.1:4328';
const apiOrigin = new URL(apiTarget).origin;

function apiProxy(): ProxyOptions {
  return {
    target: apiTarget,
    changeOrigin: false,
    configure(proxy) {
      proxy.on('proxyReq', (request) => request.setHeader('Origin', apiOrigin));
    },
  };
}

export default defineConfig({
  root: webRoot,
  base: '/ui/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api/manage': apiProxy(),
      '/a2a': apiProxy(),
      '/v1': apiProxy(),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../dist/ui', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
