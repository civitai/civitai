import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { breakpoints } from '~/utils/tailwind';

// `tailwind.config.js` is a CommonJS module, but it used to `require()` TypeScript
// sources (`./src/utils/tailwind`, `./src/tailwind/container-queries`). Node's CJS
// resolver cannot resolve `.ts`, so a plain `require()` of the config threw
// `Cannot find module './src/utils/tailwind'`.
//
// That stayed invisible because tailwind v3's own `loadConfig()` routes the config
// through its bundled jiti, and jiti *does* resolve `.ts` — so Next and the PostCSS
// pipeline loaded the real theme regardless. The dependency on a TypeScript-aware
// loader was therefore silent: any consumer that plain-`require()`s the config (a
// script, a lint rule, a bundler that inlines it), or any tailwind version that stops
// routing through jiti, would fall back to tailwind's *stock* theme instead of this
// project's — and stock tailwind has no `xs` screen and no numeric colour scale, so
// the ~80 stylesheets doing `theme('screens.xs')` / `theme('colors.blue.8')` would
// break at build time.
//
// These tests pin the plain-Node path. `createRequire` gives a genuine Node CJS
// require — no vite transform, no jiti, no TypeScript loader — i.e. exactly the
// resolver that was failing.
const nodeRequire = createRequire(import.meta.url);
const configPath = path.resolve(__dirname, '../../tailwind.config.js');

type TailwindConfig = {
  theme: { screens: Record<string, string>; extend: { containers: Record<string, string> } };
  plugins: unknown[];
};

describe('tailwind.config.js', () => {
  it('loads with a plain Node require (no jiti, no TypeScript loader)', () => {
    expect(() => nodeRequire(configPath)).not.toThrow();
  });

  it('resolves this project’s screens, not tailwind’s stock defaults', () => {
    const config = nodeRequire(configPath) as TailwindConfig;

    // Pinned literally: derived from the implementation these would pass against a
    // stock theme too. `xs` is the discriminator — stock tailwind ships
    // sm/md/lg/xl/2xl and has no `xs`.
    expect(config.theme.screens).toEqual({
      xs: '480px',
      sm: '768px',
      md: '1024px',
      lg: '1184px',
      xl: '1440px',
    });
    expect(config.theme.screens).not.toHaveProperty('2xl');
  });

  it('keeps the breakpoints single-sourced with the module app code imports', () => {
    const config = nodeRequire(configPath) as TailwindConfig;

    // If someone re-inlines the literal into either file, these drift and this fails.
    expect(config.theme.screens).toEqual(breakpoints);
    expect(config.theme.extend.containers).toEqual(breakpoints);
  });

  it('loads the container-queries plugin (the other formerly-TS require)', () => {
    const config = nodeRequire(configPath) as TailwindConfig;

    expect(config.plugins.length).toBeGreaterThanOrEqual(2);
    // tailwind plugins are `{ handler, config? }`; a failed require would have thrown
    // above, so this asserts the module actually produced a usable plugin.
    expect(config.plugins[0]).toHaveProperty('handler');
  });
});
