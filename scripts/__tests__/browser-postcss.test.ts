import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  appPostcssPlugins,
  prebuildGlobalsCss,
  prebuildMisses,
  scopedTailwind,
} from '../../test/browser-postcss.mjs';

// A small `content` keeps this fast; the routing under test does not depend on which files
// `content` names.
const repo = resolve(__dirname, '../..');
const req = createRequire(join(repo, 'package.json'));
const tailwindcss = req('tailwindcss');
const config = {
  ...req(join(repo, 'tailwind.config.js')),
  content: [join(repo, 'src/components/AppBlocks/*.tsx')],
};
const globalsCss = join(repo, 'src/styles/globals.css');
const stylesheets = execFileSync(
  'git',
  ['ls-files', 'src/**/*.module.css', 'src/**/*.module.scss', 'src/styles/globals.css'],
  { cwd: repo }
)
  .toString()
  .trim()
  .split('\n');

type Pipeline = (code: string, file: string) => Promise<string>;
async function pipeline(tailwind: () => unknown): Promise<Pipeline> {
  const vite = await import(createRequire(req.resolve('vitest/package.json')).resolve('vite'));
  const viteConfig = await vite.resolveConfig(
    {
      root: repo,
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: { '~': join(repo, 'src') } },
      css: { postcss: { plugins: appPostcssPlugins(tailwind) } },
    },
    'serve'
  );
  return async (code, file) => (await vite.preprocessCSS(code, file, viteConfig)).code;
}

describe('browser-project PostCSS', () => {
  let app: Pipeline;
  let browser: Pipeline;
  beforeAll(async () => {
    app = await pipeline(() => tailwindcss(config));
    browser = await pipeline(() => scopedTailwind(config));
  });

  it('emits the same CSS as the app for every CSS module and globals.css', async () => {
    expect(stylesheets.length).toBeGreaterThan(200);
    const differ: string[] = [];
    for (const file of stylesheets) {
      const abs = join(repo, file);
      const code = readFileSync(abs, 'utf8');
      if ((await browser(code, abs)) !== (await app(code, abs))) differ.push(file);
    }
    expect(differ).toEqual([]);
  }, 120_000);

  it('serves prebuilt globals.css once, same rules as the app, then builds it again', async () => {
    // Whitespace only: a node spliced in from the prebuilt root keeps its own indentation.
    const rules = (css: string) => css.replace(/\s+/g, ' ');
    const code = readFileSync(globalsCss, 'utf8');
    const expected = rules(await app(code, globalsCss));
    await prebuildGlobalsCss({ ...config, content: [] });
    // Prebuilt with no content, so serving the prebuilt copy shows as a difference here.
    expect(rules(await browser(code, globalsCss))).not.toBe(expected);
    expect(rules(await browser(code, globalsCss))).toBe(expected);

    await prebuildGlobalsCss(config);
    expect(rules(await browser(code, globalsCss))).toBe(expected);
    expect(prebuildMisses()).toEqual([]);
  }, 60_000);

  it('reports globals.css transformed from text other than what was prebuilt', async () => {
    await prebuildGlobalsCss(config);
    await browser(`${readFileSync(globalsCss, 'utf8')}\n/* edited */\n`, globalsCss);
    expect(prebuildMisses()).toEqual([globalsCss]);
  }, 60_000);
});
