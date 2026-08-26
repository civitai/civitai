import { defineConfig, type Plugin } from 'vite';
import path from 'path';

/**
 * Injects a `process.env` shim as the first thing in the document.
 *
 * Same need as `test/browser-process-shim.ts` in the component test project:
 * client modules (e.g. `src/env/other.ts`) read `process.env.NODE_ENV` at import
 * time. Next replaces those statically at build; Vite does not, so the module
 * graph throws `ReferenceError: process is not defined` before React mounts.
 *
 * Has to be an inline head script rather than an import — a module import would
 * be hoisted alongside the graph it needs to precede.
 */
function processShim(): Plugin {
  return {
    name: 'ladle-process-shim',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return {
          html,
          tags: [
            {
              tag: 'script',
              injectTo: 'head-prepend',
              children: `globalThis.process = globalThis.process || {};
globalThis.process.env = new Proxy(globalThis.process.env || { NODE_ENV: 'development' }, {
  get: (t, p) => (p in t ? t[p] : undefined),
});`,
            },
          ],
        };
      },
    },
  };
}

export default defineConfig({
  plugins: [processShim()],
  resolve: {
    // Array form: a string `find` matches as a PREFIX, which would rewrite the
    // shim's own `query-string/index.js` import too. Only a regex can anchor it.
    alias: [
      { find: '~', replacement: path.resolve(__dirname, '../src') },
      // See query-string-shim.mjs — CJS dep with no `main`, so Vite hands back a
      // module with no named exports and src/utils/qs.ts fails to load.
      {
        find: /^query-string$/,
        replacement: path.resolve(__dirname, './query-string-shim.mjs'),
      },
    ],
  },
  css: {
    postcss: path.resolve(__dirname, '..'),
  },
});
