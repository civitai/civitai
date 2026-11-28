import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A link to the same page on civitai.red is built by `useRedHref`, never by hand as
 * `` syncAccount(`//${redDomain}${path}`) ``. The hook is the one place that picks the
 * domain, the default path and the account sync, so a change to any of them reaches
 * every such link.
 */

const SRC = path.resolve(__dirname, '../../../../src');
const ROOTS = ['components', 'pages', 'hooks'];
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__screenshots__']);

/** Files allowed to build a red-domain link by hand, with why. */
const ALLOWED: Record<string, string> = {
  'hooks/useRedHref.ts': 'the hook itself',
  'components/ImageGeneration/QueueItem.tsx': 'generator code, changed only by its owners',
  'components/ImageGeneration/MembershipUpsell.tsx': 'generator code, changed only by its owners',
  'pages/pricing/index.tsx': 'an unsynced link with a fallback for when no red domain is set',
};

/** A template literal that starts `//${…}` with a red-domain expression inside. */
const HAND_BUILT = /`\/\/\$\{([^}]*)\}/g;
const isRed = (expr: string) => /\bred/i.test(expr);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function findHandBuiltRedHrefs(source: string): string[] {
  return [...source.matchAll(HAND_BUILT)].map((m) => m[1]).filter(isRed);
}

function scan() {
  const hits: Record<string, number> = {};
  for (const root of ROOTS) {
    for (const file of walk(path.join(SRC, root))) {
      const count = findHandBuiltRedHrefs(readFileSync(file, 'utf8')).length;
      if (count) hits[path.relative(SRC, file).split(path.sep).join('/')] = count;
    }
  }
  return hits;
}

describe('no-hand-built-red-href', () => {
  const hits = scan();

  it('builds civitai.red links only through useRedHref', () => {
    const offenders = Object.keys(hits).filter((file) => !(file in ALLOWED));
    expect(offenders).toEqual([]);
  });

  it('allows no file that no longer builds one', () => {
    expect(Object.keys(ALLOWED).filter((file) => !(file in hits))).toEqual([]);
  });

  it('matches the shapes it is meant to catch, and not green links', () => {
    expect(findHandBuiltRedHrefs('syncAccount(`//${redDomain}${router.asPath}`)')).toEqual([
      'redDomain',
    ]);
    expect(findHandBuiltRedHrefs('href={syncAccount(`//${serverDomains.red}/images/1`)}')).toEqual([
      'serverDomains.red',
    ]);
    expect(findHandBuiltRedHrefs('syncAccount(`//${serverDomains.green}/pricing`)')).toEqual([]);
  });
});
