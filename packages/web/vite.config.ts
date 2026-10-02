import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';

/** Where the API lives in development. Override when port 3000 is taken. */
const API = process.env.OPEN_ARTIFACT_API ?? 'http://127.0.0.1:3000';

/**
 * Kite's version, from the root package.json: the one place it is set, and the
 * one a vX.Y.Z tag is cut from. Baked into the bundle, so the app never has to
 * ask the server which version it is.
 */
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __KITE_VERSION__: JSON.stringify(version),
  },
  build: {
    // The server serves this directory, so one container ships both and there is
    // no separate static host to run.
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/auth': API,
      '/healthz': API,

      /*
       * Only the artifact's own bytes go to the server. The page at /a/:slug is a
       * screen in this app now, so Vite has to serve it in development just as
       * the app's catch-all does in production. Proxying all of /a would hand the
       * viewer back to the server and the sidebar would never appear.
       */
      '^/a/[^/]+/content$': API,
    },
  },
});
