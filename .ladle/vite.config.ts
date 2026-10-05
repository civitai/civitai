import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '~': path.resolve(__dirname, '../src'),
    },
  },
  css: {
    postcss: path.resolve(__dirname, '..'),
  },
  /**
   * 🔴 A `process.env` SHIM, WITHOUT WHICH A STORY CANNOT IMPORT MOST OF `src/`.
   *
   * Civitai's client modules read `process.env.NODE_ENV` / `process.env.IS_PREVIEW` AT
   * IMPORT TIME (`src/env/other.ts`, and anything reaching `~/utils/trpc`). Next replaces
   * those statically at build; Ladle's dev server does not, so importing such a module
   * throws `process is not defined` DURING RENDER — which Ladle surfaces as a blank page
   * with the story wrapper absent, i.e. a screenshot that looks like an empty component
   * rather than a crash.
   *
   * This is the Ladle twin of `test/browser-process-shim.ts`, which the browser-test tier
   * loads as its FIRST setup file for exactly the same reason; that file's docstring carries
   * the long version. `define` is the right lever here because it is a compile-time
   * substitution, so it lands before any module body evaluates — a runtime shim in
   * `components.tsx` would not, since the story's imports are hoisted above it.
   */
  define: {
    'process.env.NODE_ENV': JSON.stringify('development'),
    'process.env': '({})',
  },
});
