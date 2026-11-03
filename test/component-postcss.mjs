// The app's PostCSS pipeline, with Tailwind made cheap for the component suite. Tailwind 3 reads
// every `content` file (10k+) synchronously on Vite's main thread when it builds a context: once
// per `@apply` stylesheet, ~25 s for `globals.css`. Mid-run, that blocked the thread answering the
// browser's `userEvent` calls for 0.7-5 s at a time, and whichever test was mid-interaction timed
// out. So: only a stylesheet with an `@tailwind` rule gets the `content` scan (`@apply` and
// `theme()` resolve from the config alone), and its output is built once, before the first test
// (component-global-setup.mjs), and reused by text.
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const postcss = require('postcss');
const tailwindcss = require('tailwindcss');
const appPostcss = require('../postcss.config.js');
const tailwindConfig = require('../tailwind.config.js');

// The config bundle and the global setup load this file as two module instances in one process.
const builtWithContent = (globalThis[Symbol.for('civitai.component-tailwind-built')] ??= new Map());

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
      const key = `${result.opts.from}\0${createHash('sha1').update(root.toString()).digest('hex')}`;
      let built = builtWithContent.get(key);
      if (!built) {
        const scratch = root.clone();
        for (const step of full.plugins) await step(scratch, result);
        built = scratch.toString();
        builtWithContent.set(key, built);
      }
      root.removeAll();
      root.append(postcss.parse(built, { from: result.opts.from }).nodes);
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

export const componentPostcss = { plugins: appPostcssPlugins(() => scopedTailwind()) };

export async function buildGlobalsCss() {
  const from = require.resolve('../src/styles/globals.css');
  await postcss([scopedTailwind()]).process(readFileSync(from, 'utf8'), { from });
}
