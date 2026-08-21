import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `/apps/my-submissions` → `/apps/mine`, as a REAL redirect rather than a stub page.
 *
 * 🔴 THIS READS THE ACTUAL `next.config.mjs` EXPORT AND CALLS `redirects()`. A text scan of
 * the file would pass on a commented-out entry, on an entry in the wrong array, and on one
 * whose object never reaches the returned list — all three of which look right in a diff.
 * Invoking the function is the only check that the rule is one Next will actually serve.
 *
 * The page component is DELETED, not emptied. A stub whose only job is to redirect is dead
 * code that reads as a live route, and the completeness walk in
 * `src/components/Apps/__tests__/appsPageWidths.test.ts` would then demand a width
 * classification for a page that never renders.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nextConfig = (await import('../../../next.config.mjs')).default as any;

type Redirect = {
  source: string;
  destination: string;
  permanent?: boolean;
  statusCode?: number;
};

const redirects = (await nextConfig.redirects()) as Redirect[];

describe('the /apps/my-submissions → /apps/mine redirect', () => {
  it('POSITIVE CONTROL: the redirect list is populated and reachable', () => {
    // 🔴 Without this, every assertion below could be satisfied by a `find` over an empty
    // array producing `undefined` and a `toBeDefined()` that someone later softened. A
    // reassuring "no match" is indistinguishable from a probe wired to nothing.
    expect(Array.isArray(redirects)).toBe(true);
    expect(redirects.length).toBeGreaterThan(5);
    expect(redirects.some((r) => r.source === '/discord')).toBe(true);
  });

  it('🔴 301s to /apps/mine', () => {
    const rule = redirects.find((r) => r.source === '/apps/my-submissions');
    expect(rule).toBeDefined();
    expect(rule!.destination).toBe('/apps/mine');
    // 🔴 301, not `permanent: true` — Next maps `permanent` to 308, which preserves the
    // request METHOD. This is a GET-only author page whose inbound links are bookmarks,
    // notification URLs and search results; 301 is the status those consumers cache and
    // rewrite on. The two options are mutually exclusive in Next's schema.
    expect(rule!.statusCode).toBe(301);
    expect(rule!.permanent).toBeUndefined();
  });

  it('🔴 the page component is GONE — the redirect is not sitting behind dead code', () => {
    const pagesDir = path.resolve(__dirname, '../../pages/apps');
    expect(fs.existsSync(pagesDir)).toBe(true); // control: we are looking in the right place
    expect(fs.existsSync(path.join(pagesDir, 'my-submissions.tsx'))).toBe(false);
    // …and the surviving route DOES have a page, so this is a merge and not a deletion.
    expect(fs.existsSync(path.join(pagesDir, 'mine.tsx'))).toBe(true);
  });

  it('no in-app link still points at the retired route', () => {
    // A link to a redirected route costs a round trip and re-renders the whole shell. The
    // redirect is for BOOKMARKS and notification URLs already in the wild, not for links
    // this codebase is still emitting today.
    const srcDir = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (name.isDirectory()) {
          if (name.name === 'node_modules' || name.name === '__screenshots__') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        // Only LINK-shaped occurrences: a quoted string literal. Prose in comments that
        // explains the retired route is documentation, not a link.
        if (/(?:href|destination)\s*[=:]\s*['"]\/apps\/my-submissions['"]/.test(text)) {
          offenders.push(path.relative(srcDir, full));
        }
        if (/router\.(?:push|replace)\(\s*['"]\/apps\/my-submissions['"]/.test(text)) {
          offenders.push(path.relative(srcDir, full));
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
