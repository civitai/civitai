import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../../test/strip-comments';

/**
 * 🔴 SOURCE GATE: no code reads an item definition's TRADABLE flag (bit 2 of `ItemDefinition.flags`).
 *
 * Nothing in v1 can be traded, gifted or resold, and turning trading on is a Legal and counsel
 * decision, not a config flip. The bit exists in the schema so the flags column need not change
 * later; this keeps it inert until that decision is made. Whoever turns trading on deletes this
 * guard in the same PR, where review sees it.
 *
 * Two forms are refused in non-test code under src/, apps/ and packages/:
 * - any identifier or string naming it (`tradable`, any case), comments stripped;
 * - a bit test on `flags` with a mask that has bit 2 set, in a file that mentions item definitions.
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'apps', 'packages'];
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte']);
const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', '.next', 'build', 'dist', 'generated']);
const isTestFile = (file: string) => /\.test\.|[\\/]__tests__[\\/]/.test(file);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXTENSIONS.has(path.extname(entry)) && !isTestFile(full)) out.push(full);
  }
  return out;
}

// Svelte markup comments too.
const stripAllComments = (s: string) => stripComments(s).replace(/<!--[\s\S]*?-->/g, ' ');

const NAMES_IT = /tradable/i;
const MENTIONS_ITEM_DEFINITION = /item_?definition/i;
const FLAGS_MASK = /\bflags\b["'`\]]?\s*&\s*(0x[0-9a-f]+|0b[01]+|\d+)/gi;
// The shared bit helpers (`Flags.hasFlag`, `Flags.intersects`) with a literal mask.
const FLAGS_HELPER =
  /\b(?:hasFlag|intersects)\(\s*[^,()]*\bflags\b[^,()]*,\s*(0x[0-9a-f]+|0b[01]+|\d+)/gi;

const readsTradableBit = (source: string) =>
  MENTIONS_ITEM_DEFINITION.test(source) &&
  [...source.matchAll(FLAGS_MASK), ...source.matchAll(FLAGS_HELPER)].some(
    (match) => (Number(match[1]) & 2) !== 0
  );

const offends = (source: string) => {
  const code = stripAllComments(source);
  return NAMES_IT.test(code) || readsTradableBit(code);
};

const filesByRoot = Object.fromEntries(
  ROOTS.map((root) => [root, walk(path.join(repoRoot, root))])
);
const files = Object.values(filesByRoot).flat();

describe('🔴 no code reads the TRADABLE item flag', () => {
  it('the scan reached every root', () => {
    // A walker returning [] would pass everything below. Far under the real counts.
    expect(filesByRoot.src.length).toBeGreaterThan(1000);
    expect(filesByRoot.apps.length).toBeGreaterThan(200);
    expect(filesByRoot.packages.length).toBeGreaterThan(100);
  });

  describe('positive controls: the matcher sees each form', () => {
    it.each([
      ['a named constant', 'if (def.flags & ITEM_FLAG.tradable) allow();'],
      ['an upper-case name', 'const TRADABLE = 2;'],
      ['a helper', 'export const isTradable = (d: Def) => true;'],
      ['a raw bit test', 'const itemDefinition = row; if (itemDefinition.flags & 2) trade();'],
      ['a mask with bit 2 among others', 'itemDefinition; const ok = (flags & 0x6) !== 0;'],
      ['SQL', 'SELECT 1 FROM "ItemDefinition" WHERE "flags" & 2 = 2'],
      ['the shared bit helper', 'itemDefinition; if (Flags.hasFlag(def.flags, 2)) trade();'],
      ['the shared intersects helper', 'itemDefinition; Flags.intersects(row.flags, 6);'],
    ])('%s', (_, source) => {
      expect(offends(source)).toBe(true);
    });

    it.each([
      ['ROLLABLE only', 'itemDefinition; if (def.flags & 1) roll();'],
      ['DISCARDABLE only', 'itemDefinition; if (def.flags & 4) discard();'],
      ['the bit helper on ROLLABLE', 'itemDefinition; Flags.hasFlag(def.flags, 1);'],
      ['a markup comment naming it', '<!-- tradable --><div></div>'],
      ['a flags bit test outside item code', 'if (version.flags & 2) hide();'],
      ['a comment naming it', '// tradable is not read in v1\nconst a = 1;'],
      ['a block comment naming it', '/* TRADABLE */ const a = 1;'],
      ['a URL is not a comment', 'const u = "https://example.com"; itemDefinition; x.flags & 1;'],
    ])('does not flag %s', (_, source) => {
      expect(offends(source)).toBe(false);
    });
  });

  it('no file reads it', () => {
    const offenders = files
      .filter((file) => offends(readFileSync(file, 'utf8')))
      .map((file) => path.relative(repoRoot, file));
    expect(
      offenders,
      'Trading, gifting and resale need Legal and counsel before any code reads the TRADABLE flag.'
    ).toEqual([]);
  });
});
