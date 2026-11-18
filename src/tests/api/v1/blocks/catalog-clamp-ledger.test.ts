import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * LEDGER — which App Blocks code resolves a catalog maturity level, and with which clamp.
 *
 * Two clamps exist:
 *   - `resolveCatalogBrowsingLevel(` — the token's DOMAIN ceiling alone. On a mature
 *     domain it serves mature covers to a viewer whose own settings are PG.
 *   - `resolveCatalogViewerBrowsingLevel(` — the viewer's level held to the domain cap
 *     (the main site's rule). What a route that shows media to a viewer must use.
 *     `resolveCatalogViewerMaturity(` is the same clamp plus its SFW-ceiling flag, so a
 *     call to either counts as the viewer clamp.
 *
 * The clamp is NOT inherited from the `/api/v1/blocks/*` prefix, so a new media route
 * that reaches for the domain-only clamp looks exactly as protected as its neighbours.
 * This ledger is the check: both sets are derived from the source and compared with
 * the lists below in BOTH directions, so adding a caller, removing one, or moving one
 * between clamps fails here until the list (and its why) is updated deliberately.
 *
 * Comments are stripped first, so prose naming a clamp cannot satisfy the scan.
 */

const ROOTS = ['src/pages/api/v1/blocks', 'src/server/services/blocks'].map((r) =>
  path.join(process.cwd(), r)
);

/** The viewer clamp's two entry points (`block-catalog-viewer-level.ts`). */
const VIEWER_CLAMPS = ['resolveCatalogViewerBrowsingLevel', 'resolveCatalogViewerMaturity'];

/** Callers of the VIEWER clamp. Every viewer-facing catalog route belongs here. */
const VIEWER_CLAMP_CALLERS = [
  'src/pages/api/v1/blocks/collections/[id]/index.ts',
  'src/pages/api/v1/blocks/collections/index.ts',
  'src/pages/api/v1/blocks/generation-resources.ts',
  'src/pages/api/v1/blocks/images.ts',
  'src/pages/api/v1/blocks/models.ts',
  'src/pages/api/v1/blocks/resource-intent.ts',
  'src/pages/api/v1/blocks/tools.ts',
];

/** Callers of the DOMAIN-ONLY clamp, each with why it may still use it. */
const DOMAIN_CLAMP_CALLERS: Record<string, string> = {};

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(full);
    return e.isFile() && /\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : [];
  });
}

/** A call to any of `fns` — the one pattern both the scan and its controls use. */
function callPattern(...fns: string[]): RegExp {
  return new RegExp(`\\b(?:${fns.join('|')})\\(`);
}

function callersOf(...fns: string[]): string[] {
  const call = callPattern(...fns);
  return ROOTS.flatMap(walk)
    .filter((full) => call.test(stripComments(readFileSync(full, 'utf8'))))
    .map((full) => path.relative(process.cwd(), full).split(path.sep).join('/'))
    .sort();
}

describe('block catalog maturity clamp ledger', () => {
  it('the viewer clamp callers are exactly the ledger', () => {
    expect(callersOf(...VIEWER_CLAMPS)).toEqual([...VIEWER_CLAMP_CALLERS].sort());
  });

  it('the domain-only clamp callers are exactly the ledger, each with a why', () => {
    expect(callersOf('resolveCatalogBrowsingLevel')).toEqual(
      Object.keys(DOMAIN_CLAMP_CALLERS).sort()
    );
    for (const why of Object.values(DOMAIN_CLAMP_CALLERS)) expect(why.length).toBeGreaterThan(20);
  });

  it('no file calls both clamps', () => {
    const viewer = new Set(callersOf(...VIEWER_CLAMPS));
    expect(callersOf('resolveCatalogBrowsingLevel').filter((f) => viewer.has(f))).toEqual([]);
  });

  it('positive control: the scan sees a call, and does not see one in a comment', () => {
    const call = callPattern('resolveCatalogBrowsingLevel');
    expect(call.test(stripComments('const x = resolveCatalogBrowsingLevel(claims);'))).toBe(true);
    expect(call.test(stripComments('// resolveCatalogBrowsingLevel(claims)'))).toBe(false);
    expect(call.test(stripComments('/* resolveCatalogBrowsingLevel(claims) */'))).toBe(false);
    // The viewer clamp's name is not read as a domain-clamp call.
    expect(call.test(stripComments('resolveCatalogViewerBrowsingLevel(claims)'))).toBe(false);
    expect(call.test(stripComments('resolveCatalogViewerMaturity(claims)'))).toBe(false);
  });

  it('positive control: the viewer scan sees a call to either entry point', () => {
    const call = callPattern(...VIEWER_CLAMPS);
    expect(call.test(stripComments('const l = resolveCatalogViewerBrowsingLevel(claims);'))).toBe(
      true
    );
    expect(call.test(stripComments('const m = resolveCatalogViewerMaturity(claims);'))).toBe(true);
    expect(call.test(stripComments('// resolveCatalogViewerMaturity(claims)'))).toBe(false);
    // The domain-only clamp is not read as a viewer-clamp call.
    expect(call.test(stripComments('resolveCatalogBrowsingLevel(claims)'))).toBe(false);
  });
});
