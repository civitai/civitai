import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * 🔴 SOURCE GATE — next/image must stay unoptimized; images are served directly.
 *
 * `images.unoptimized: true` in next.config.mjs turns the built-in optimizer off. Nothing else in
 * the repo notices if it is switched back on, or bypassed per-component, because the pages still
 * render. Four things re-enable it, and each is checked below:
 *   1. `images.unoptimized` no longer `true` in next.config.mjs.
 *   2. `images.loader` / `images.loaderFile` set in next.config.mjs.
 *   3. an `<Image unoptimized={false}>` or `<Image loader={...}>` on a next/image component.
 *   4. any import of `next/legacy/image`.
 *
 * If you are here because this went red: don't loosen the match. Remove the offending change.
 *
 * Shortcut: the JSX scan is textual (no AST). It follows the local name next/image is imported as
 * and reads up to the next `<`/`>` (arrow `=>` allowed), so a prop value containing JSX could hide
 * a `loader=` from it. Upgrade to a parser if that ever happens.
 */

const ROOT = path.resolve(__dirname, '../../../..');
const MESSAGE = 'next/image must stay unoptimized; images are served directly.';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']);
const SKIP_DIRS = new Set(['node_modules', '__screenshots__', '.next', 'dist']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

const appsDir = path.join(ROOT, 'apps');
const roots = [
  path.join(ROOT, 'src'),
  ...(existsSync(appsDir) ? readdirSync(appsDir) : [])
    .map((app) => path.join(appsDir, app, 'src'))
    .filter((dir) => existsSync(dir)),
];
// This file's own fixtures spell out the forbidden forms, so it is the one file not scanned.
const files = roots.flatMap((dir) => walk(dir)).filter((f) => f !== __filename);

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Any import/require of `next/legacy/image`, static or dynamic. */
const legacyImport = /['"]next\/legacy\/image['"]/;

/** Local names bound to the default export of `next/image`. */
function imageNames(source: string): string[] {
  const names: string[] = [];
  const re = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]next\/image['"]/g;
  for (const m of source.matchAll(re)) names.push(m[1]);
  return names;
}

/** `<Name ... unoptimized={false}` or `<Name ... loader=` within one opening tag. */
function overridesOptimizer(source: string): boolean {
  return imageNames(source).some((name) =>
    new RegExp(
      String.raw`<${name}\b(?:[^<>]|=>)*?(?:\bunoptimized\s*=\s*\{\s*false\s*\}|\bloader\s*=)`
    ).test(source)
  );
}

/** The text between the braces of `images: { ... }`, nested braces balanced. */
function imagesBlock(config: string): string | null {
  const start = config.search(/\bimages\s*:\s*\{/);
  if (start === -1) return null;
  const open = config.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < config.length; i++) {
    if (config[i] === '{') depth++;
    else if (config[i] === '}' && --depth === 0) return config.slice(open + 1, i);
  }
  return null;
}

const configProblems = (config: string): string[] => {
  const block = imagesBlock(stripComments(config));
  if (block === null) return ['next.config.mjs has no `images: { ... }` block'];
  const problems: string[] = [];
  if (!/\bunoptimized\s*:\s*true\b/.test(block))
    problems.push('`images.unoptimized` is not `true`');
  if (/\bloader\s*:/.test(block)) problems.push('`images.loader` is set');
  if (/\bloaderFile\s*:/.test(block)) problems.push('`images.loaderFile` is set');
  return problems;
};

describe(`🔴 ${MESSAGE}`, () => {
  it('the scan actually reached the source tree', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  describe('positive controls — the matchers can see what they are looking for', () => {
    const image = `import Image from 'next/image';\n`;
    it.each([
      ['unoptimized={false}', `${image}const a = <Image src="/a.png" unoptimized={false} />;`],
      ['loader=', `${image}const a = <Image src="/a.png" loader={myLoader} />;`],
      [
        'multi-line with an arrow prop before it',
        `${image}const a = (\n<Image\n  onLoad={() => go()}\n  loader={myLoader}\n/>);`,
      ],
      [
        'aliased import',
        `import NextImage from 'next/image';\nconst a = <NextImage unoptimized={false} />;`,
      ],
    ])('flags %s', (_label, source) => {
      expect(overridesOptimizer(source)).toBe(true);
    });

    it.each([
      ['a plain Image', `import Image from 'next/image';\nconst a = <Image src="/a.png" />;`],
      [
        'unoptimized={true}',
        `import Image from 'next/image';\nconst a = <Image src="/a.png" unoptimized={true} />;`,
      ],
      [
        'a non-next Image with a loader',
        `import { Image } from '@mantine/core';\nconst a = <Image loader={x} />;`,
      ],
      [
        'loader on a different element after a closed tag',
        `import Image from 'next/image';\nconst a = <Image src="/a.png" />;\nconst b = <Foo loader={x} />;`,
      ],
    ])('does NOT flag %s', (_label, source) => {
      expect(overridesOptimizer(source)).toBe(false);
    });

    it('flags next/legacy/image in static and dynamic form', () => {
      expect(legacyImport.test(`import Image from 'next/legacy/image';`)).toBe(true);
      expect(legacyImport.test(`await import("next/legacy/image")`)).toBe(true);
      expect(legacyImport.test(`import Image from 'next/image';`)).toBe(false);
    });

    it('flags each bad next.config images block, and passes the good one', () => {
      const good = `images: { unoptimized: true, remotePatterns: [{ hostname: 'a' }] }`;
      expect(configProblems(good)).toEqual([]);
      expect(configProblems(good.replace('true', 'false'))).toHaveLength(1);
      expect(configProblems(`images: { remotePatterns: [{ hostname: 'a' }] }`)).toHaveLength(1);
      expect(configProblems(good.replace('}', ", loader: 'custom' }"))).toHaveLength(1);
      expect(configProblems(good.replace('}', ", loaderFile: './l.js' }"))).toHaveLength(1);
      expect(configProblems(`const x = 1;`)).toHaveLength(1);
      expect(
        configProblems(`// images: { unoptimized: true }\nimages: { unoptimized: false }`)
      ).toHaveLength(1);
    });
  });

  it('next.config.mjs keeps the built-in optimizer off', () => {
    const config = readFileSync(path.join(ROOT, 'next.config.mjs'), 'utf8');
    expect(configProblems(config), MESSAGE).toEqual([]);
  });

  it('no next/image component re-enables the optimizer', () => {
    const offenders = files
      .filter((file) => overridesOptimizer(stripComments(readFileSync(file, 'utf8'))))
      .map((f) => path.relative(ROOT, f));
    expect(offenders, `${MESSAGE} Remove \`unoptimized={false}\` / \`loader=\`.`).toEqual([]);
  });

  it('nothing imports next/legacy/image', () => {
    const offenders = files
      .filter((file) => legacyImport.test(stripComments(readFileSync(file, 'utf8'))))
      .map((f) => path.relative(ROOT, f));
    expect(offenders, `${MESSAGE} Use next/image, not next/legacy/image.`).toEqual([]);
  });
});
