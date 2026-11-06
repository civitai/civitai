// The app's PostCSS, with Tailwind's `content` scan confined to stylesheets with an `@tailwind`
// rule. The scan runs synchronously on Vite's main thread and stalls the browser's `userEvent` RPC
// mid-test; `@apply` and `theme()` resolve from the config alone. The `@tailwind` output is
// prebuilt in browser-global-setup.mjs and handed to the first transform that asks for it.
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const postcss = require('postcss');
const tailwindcss = require('tailwindcss');
const appPostcss = require('../postcss.config.js');
const tailwindConfig = require('../tailwind.config.js');

// The config bundle and the global setup load this file as two module instances in one process.
const state = (globalThis[Symbol.for('civitai.browser-postcss')] ??= {
  prebuilt: new Map(),
  missed: [],
});

const keyOf = (from, css) => `${from}\0${createHash('sha1').update(css).digest('hex')}`;

export function scopedTailwind(config = tailwindConfig) {
  const full = tailwindcss(config);
  const lean = tailwindcss({ ...config, content: [{ raw: '', extension: 'html' }] });
  return {
    postcssPlugin: 'tailwindcss-content-scoped',
    async Once(root, { result }) {
      let readsContent = false;
      root.walkAtRules('tailwind', () => {
        readsContent = true;
        return false;
      });
      if (!readsContent) {
        for (const step of lean.plugins) await step(root, result);
        return;
      }
      const from = result.opts.from;
      const key = keyOf(from, root.toString());
      const prebuilt = state.prebuilt.get(key);
      if (!prebuilt) {
        if ([...state.prebuilt.keys()].some((k) => k.startsWith(`${from}\0`))) state.missed.push(from);
        for (const step of full.plugins) await step(root, result);
        return;
      }
      // Once only: a later transform (watch mode) rebuilds, so new classes and config edits show.
      state.prebuilt.delete(key);
      result.messages.push(...prebuilt.messages);
      root.removeAll();
      root.append(prebuilt.root.clone().nodes);
    },
  };
}
scopedTailwind.postcss = true;

/** The app's PostCSS plugin list, in order, with `tailwindcss` swapped for `replaceTailwind()`. */
export function appPostcssPlugins(replaceTailwind) {
  return Object.entries(appPostcss.plugins).map(([name, options]) =>
    name === 'tailwindcss' ? replaceTailwind() : require(name)(options)
  );
}

export const browserPostcss = { plugins: appPostcssPlugins(() => scopedTailwind()) };

export async function prebuildGlobalsCss(config = tailwindConfig) {
  state.prebuilt.clear();
  state.missed.length = 0;
  const from = require.resolve('../src/styles/globals.css');
  const css = readFileSync(from, 'utf8');
  const result = await postcss([tailwindcss(config)]).process(css, { from });
  state.prebuilt.set(keyOf(from, css), { root: result.root, messages: result.messages });
}

/** Stylesheets that were prebuilt but transformed from a different key, so paid the scan mid-run. */
export const prebuildMisses = () => [...state.missed];
