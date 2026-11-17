import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Pins the `resolve-href.js` hunks of `patches/next@16.4.5.patch`. Every `next/link` render
 * calls `resolveHref`, which parses two URLs. For an href starting with a single "/" the result
 * depends only on the href and `resolveAs` (the router contributes only a base URL, which an
 * absolute path replaces), so the patch memoizes exactly those inputs and sends everything else
 * through the original function.
 *
 * 🔴 If this file fails after a Next.js upgrade, re-read `resolveHref` in both
 * `dist/client/resolve-href.js` and `dist/esm/client/resolve-href.js`, regenerate the hunks or
 * drop them, and keep the rest of the next patch intact.
 */

type Router = { pathname: string; asPath: string };
type ResolveHref = (router: Router, href: unknown, resolveAs?: boolean) => string | string[];

const requireHere = createRequire(import.meta.url);
const nextDir = path.dirname(requireHere.resolve('next/package.json'));

// Pages-router server code `require`s the CommonJS file; client bundles take the ESM copy.
const builds: Array<[string, () => Promise<ResolveHref>]> = [
  [
    'CommonJS',
    async () => requireHere(path.join(nextDir, 'dist/client/resolve-href.js')).resolveHref,
  ],
  [
    'ESM',
    async () =>
      (
        await import(
          /* @vite-ignore */ pathToFileURL(path.join(nextDir, 'dist/esm/client/resolve-href.js'))
            .href
        )
      ).resolveHref,
  ],
];

const DYNAMIC_ROUTER: Router = {
  pathname: '/models/[id]/[[...slug]]',
  asPath: '/models/1/foo?x=1',
};
const OTHER_ROUTER: Router = { pathname: '/user/[username]', asPath: '/user/bob#h' };

// Outputs of the UNPATCHED 16.4.5 resolveHref under DYNAMIC_ROUTER — generated before the patch
// was written. [href, resolveHref(router, href, true), resolveHref(router, href)].
const EXPECTED: Array<[string, string[], string]> = [
  ['/', ['/', '/'], '/'],
  ['/models/1', ['/models/1', '/models/1'], '/models/1'],
  ['/models/[id]?id=5&x=2', ['/models/[id]?id=5&x=2', '/models/5?x=2'], '/models/[id]?id=5&x=2'],
  ['/models/1?x=1#y', ['/models/1?x=1#y', '/models/1?x=1#y'], '/models/1?x=1#y'],
  ['/a/b/../c', ['/a/c', '/a/c'], '/a/c'],
  [
    '/images?tags=1&tags=2',
    ['/images?tags=1&tags=2', '/images?tags=1&tags=2'],
    '/images?tags=1&tags=2',
  ],
  [
    '/models/[id]/[[...slug]]?id=3&slug=a&slug=b',
    ['/models/[id]/[[...slug]]?id=3&slug=a&slug=b', '/models/3/a/b'],
    '/models/[id]/[[...slug]]?id=3&slug=a&slug=b',
  ],
];

/** Counts URL constructions — the work the memo exists to skip. */
function countUrlConstructions() {
  const RealURL = globalThis.URL;
  let count = 0;
  class CountingURL extends RealURL {
    constructor(url: string | URL, base?: string | URL) {
      super(url, base);
      count++;
    }
  }
  globalThis.URL = CountingURL as typeof URL;
  return {
    get count() {
      return count;
    },
    restore: () => {
      globalThis.URL = RealURL;
    },
  };
}

let restoreUrl: (() => void) | undefined;
afterEach(() => {
  restoreUrl?.();
  restoreUrl = undefined;
  vi.restoreAllMocks();
});

let unique = 0;
const freshHref = () => `/memo-probe/${process.pid}/${++unique}?q=${unique}`;

describe.each(builds)('next resolveHref (%s build)', (_name, load) => {
  it('memoizes a root-relative href: the second call parses no URL', async () => {
    const resolveHref = await load();
    const href = freshHref();
    const counter = countUrlConstructions();
    restoreUrl = counter.restore;

    const first = resolveHref(DYNAMIC_ROUTER, href, true);
    const afterFirst = counter.count;
    // Positive control: the instrument sees the uncached call's URL parsing.
    expect(afterFirst).toBeGreaterThan(0);

    // A different router: for a root-relative href it cannot change the answer.
    const second = resolveHref(OTHER_ROUTER, href, true);
    expect(counter.count).toBe(afterFirst);
    expect(second).toEqual(first);
  });

  it('keys on resolveAs as well as the href', async () => {
    const resolveHref = await load();
    const href = '/models/[id]?id=77';
    expect(resolveHref(DYNAMIC_ROUTER, href, true)).toEqual([href, '/models/77']);
    expect(resolveHref(DYNAMIC_ROUTER, href)).toBe(href);
    expect(resolveHref(DYNAMIC_ROUTER, href, true)).toEqual([href, '/models/77']);
  });

  it.each(EXPECTED)(
    'returns the unpatched result for %s, cold and warm',
    async (href, asTuple, plain) => {
      const resolveHref = await load();
      for (let i = 0; i < 2; i++) {
        expect(resolveHref(DYNAMIC_ROUTER, href, true)).toEqual(asTuple);
        expect(resolveHref(DYNAMIC_ROUTER, href)).toBe(plain);
      }
    }
  );

  it('hands out a copy, so a caller cannot alter a cached result', async () => {
    const resolveHref = await load();
    const href = freshHref();
    const first = resolveHref(DYNAMIC_ROUTER, href, true) as string[];
    const snapshot = [...first];
    first[0] = 'tampered';
    first.push('extra');
    expect(resolveHref(DYNAMIC_ROUTER, href, true)).toEqual(snapshot);
  });

  it('does not memoize router-relative hrefs', async () => {
    const resolveHref = await load();
    expect(resolveHref({ pathname: '/a/b', asPath: '/a/b' }, 'c', true)).toEqual(['/a/c', '/a/c']);
    expect(resolveHref({ pathname: '/x/y', asPath: '/x/y' }, 'c', true)).toEqual(['/x/c', '/x/c']);
    expect(resolveHref({ pathname: '/a', asPath: '/a' }, '?z=1', true)).toEqual([
      '/a?z=1',
      '/a?z=1',
    ]);
    expect(resolveHref({ pathname: '/b', asPath: '/b' }, '?z=1', true)).toEqual([
      '/b?z=1',
      '/b?z=1',
    ]);
  });

  it('still warns on every call for a repeated-slash href (not memoized)', async () => {
    const resolveHref = await load();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const href = `/a//b-${++unique}`;
    resolveHref(DYNAMIC_ROUTER, href, true);
    resolveHref(DYNAMIC_ROUTER, href, true);
    expect(error).toHaveBeenCalledTimes(2);
  });
});
