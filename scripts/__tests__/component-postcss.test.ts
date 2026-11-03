import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { appPostcssPlugins, scopedTailwind } from '../../test/component-postcss.mjs';

// The component suite's PostCSS must emit exactly what the app's does, for every stylesheet a
// browser test can load. A small `content` keeps this fast; the routing under test does not
// depend on which files `content` names.
const repo = resolve(__dirname, '../..');
const req = createRequire(join(repo, 'package.json'));
const tailwindcss = req('tailwindcss');
const config = {
  ...req(join(repo, 'tailwind.config.js')),
  content: [join(repo, 'src/components/AppBlocks/*.tsx')],
};
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

describe('component PostCSS', () => {
  let app: Pipeline;
  let component: Pipeline;
  let noContent: Pipeline;
  beforeAll(async () => {
    app = await pipeline(() => tailwindcss(config));
    component = await pipeline(() => scopedTailwind(config));
    noContent = await pipeline(() => tailwindcss({ ...config, content: [] }));
  });

  it('emits the same CSS as the app for every CSS module and globals.css, built or reused', async () => {
    expect(stylesheets.length).toBeGreaterThan(200);
    const differ: string[] = [];
    for (const file of stylesheets) {
      const abs = join(repo, file);
      const code = readFileSync(abs, 'utf8');
      const expected = await app(code, abs);
      if ((await component(code, abs)) !== expected) differ.push(file);
      if ((await component(code, abs)) !== expected) differ.push(`${file} (reused)`);
    }
    expect(differ).toEqual([]);
  }, 120_000);

  it('would see globals.css lose its content-picked utilities', async () => {
    const abs = join(repo, 'src/styles/globals.css');
    const code = readFileSync(abs, 'utf8');
    expect(await noContent(code, abs)).not.toBe(await app(code, abs));
  }, 60_000);
});
