import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { rewriteDevApiProxyPath } from './src/shared/web-api-routing.ts';
import { DEFAULT_BACKEND_PORT, DEFAULT_WEB_PORT, PRODUCT_NAME } from '../config/app-config.mjs';
import { buildCommit } from '../config/build-commit.mjs';

const root = resolve(import.meta.dirname, 'src/renderer');
// Opt-in subpath build for a reverse proxy that serves the UI under a prefix
// (e.g. JINVOICE_WEB_BASE=/jinvoice/app/). Default `/` keeps the normal build.
// JINVOICE_WEB_OUT sends that build elsewhere so frontend/dist (bundled into
// the desktop installer) stays the root-base build.
const webBase = normalizeWebBase(process.env.JINVOICE_WEB_BASE);
const webDist = resolve(import.meta.dirname, process.env.JINVOICE_WEB_OUT?.trim() || '../frontend/dist');

function normalizeWebBase(value: string | undefined): string {
  const raw = (value || '/').trim();
  if (!raw || raw === '/') return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\s?#\\]/.test(raw)) {
    throw new Error(`JINVOICE_WEB_BASE must be an absolute path such as /jinvoice/app/ (got ${raw})`);
  }
  return `/${raw.replace(/^\/+|\/+$/g, '')}/`;
}
const version = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
).version;
const backendPort = process.env.OMNIVOICE_PORT || String(DEFAULT_BACKEND_PORT);

export default defineConfig({
  root,
  base: webBase,
  publicDir: resolve(import.meta.dirname, 'public'),
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'app-identity',
      transformIndexHtml(html) {
        return html.replaceAll('__APP_PRODUCT_NAME__', PRODUCT_NAME);
      },
    },
    {
      name: 'renderer-boot-script',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'early-error-capture.js',
          source: readFileSync(resolve(import.meta.dirname, 'public/early-error-capture.js')),
        });
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
    __WEB_DEPLOYMENT__: true,
  },
  resolve: {
    alias: {
      '@': resolve(root, 'src'),
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@vercel/oidc': resolve(root, 'src/lib/vercel-oidc-browser.ts'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: { exclude: ['@scalar/api-reference-react'] },
  server: {
    host: 'localhost',
    // Same name the backend reads for its CORS/CSRF allow-list (core/csrf.py);
    // VOICESTUDIO_UI_PORT remains an accepted alias.
    port:
      Number(process.env.OMNIVOICE_UI_PORT || process.env.VOICESTUDIO_UI_PORT) || DEFAULT_WEB_PORT,
    strictPort: true,
    proxy: {
      '/api/ws': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        ws: true,
      },
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
        // Four backend router families genuinely own `/api`; every other
        // renderer request uses `/api` only as the Vite/Electron proxy prefix.
        rewrite: rewriteDevApiProxyPath,
      },
    },
  },
  build: {
    outDir: webDist,
    emptyOutDir: true,
    rollupOptions: { input: resolve(root, 'index.html') },
  },
});
