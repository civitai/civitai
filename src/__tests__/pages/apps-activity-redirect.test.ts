import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `/apps/installed` → `/apps/activity`, as a REAL redirect rather than a stub page.
 *
 * The page stopped being an installs surface: it opens on the activity feed, its
 * `Installs` tab is gated on the model-slot flag, and its own gate widened to
 * `appBlocks || appBlocksPages` so a viewer whose only app usage is a full-page app
 * reaches it. The route name followed.
 *
 * 🔴 THIS READS THE ACTUAL `next.config.mjs` EXPORT AND CALLS `redirects()`. A text scan
 * of the file would pass on a commented-out entry, on an entry in the wrong array, and
 * on one whose object never reaches the returned list — all three of which look right in
 * a diff. Invoking the function is the only check that the rule is one Next will serve.
 *
 * Structure and controls deliberately mirror `apps-build-redirects.test.ts`, which is
 * the same job for the `/apps/build` consolidation; that file owns its own three routes
 * and this one owns this route, so neither's ledger can absorb the other's silently.
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

const RETIRED_ROUTE = '/apps/installed';
const DESTINATION = '/apps/activity';

describe('the /apps/installed → /apps/activity redirect', () => {
  it('POSITIVE CONTROL: the redirect list is populated and reachable', () => {
    // 🔴 Without this, every assertion below could be satisfied by a `find` over an empty
    // array producing `undefined`. A reassuring "no match" is indistinguishable from a
    // probe wired to nothing.
    expect(Array.isArray(redirects)).toBe(true);
    expect(redirects.length).toBeGreaterThan(5);
    expect(redirects.some((r) => r.source === '/discord')).toBe(true);
  });

  it('🔴 /apps/installed 301s to /apps/activity', () => {
    const rule = redirects.find((r) => r.source === RETIRED_ROUTE);
    expect(rule, `no redirect rule for ${RETIRED_ROUTE}`).toBeDefined();
    expect(rule!.destination).toBe(DESTINATION);
    // 🔴 301, not `permanent: true` — Next maps `permanent` to 308, which preserves the
    // request METHOD. This is a GET-only page whose inbound links are bookmarks and
    // search results; 301 is the status those consumers cache and rewrite on. The two
    // options are mutually exclusive in Next's schema.
    expect(rule!.statusCode).toBe(301);
    expect(rule!.permanent).toBeUndefined();
  });

  it('🔴 it does not land on another redirect', () => {
    // A 301→301 costs a round trip, and some link-equity and bookmark-rewriting
    // consumers stop following after the first hop.
    const sources = new Set(redirects.map((r) => r.source));
    expect(sources.has(DESTINATION)).toBe(false);
    // Guard-the-guard: a `sources` set built from an empty list makes the check above
    // trivially pass. Prove the lookup can hit.
    expect(sources.has(RETIRED_ROUTE)).toBe(true);
  });

  it('🔴 the page MOVED — installed.tsx is gone and activity.tsx exists', () => {
    // A stub whose only job is to redirect is dead code that reads as a live route, and
    // `appsPageWidths`' fs-walk would then demand a width classification for a page that
    // never renders. So the component is moved, not emptied.
    const pagesDir = path.resolve(__dirname, '../../pages/apps');
    expect(fs.existsSync(pagesDir)).toBe(true); // control: looking in the right place
    expect(fs.existsSync(path.join(pagesDir, 'installed.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(pagesDir, 'activity.tsx'))).toBe(true);
  });

  it('no in-app link still points at /apps/installed', () => {
    // A link to a redirected route costs a round trip and re-renders the whole shell. The
    // redirect is for BOOKMARKS and notification URLs already in the wild, not for links
    // this codebase is still emitting today.
    const srcDir = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    const linkish = new RegExp(`(?:href|destination)\\s*[=:]\\s*['"]${RETIRED_ROUTE}['"]`);
    const pushy = new RegExp(`router\\.(?:push|replace)\\(\\s*['"]${RETIRED_ROUTE}['"]`);
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (name.isDirectory()) {
          if (name.name === 'node_modules' || name.name === '__screenshots__') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name.name)) continue;
        // This file names the retired route as DATA. Excluding self is what keeps the
        // guard from reporting itself.
        if (full === __filename) continue;
        const text = fs.readFileSync(full, 'utf8');
        // Only LINK-shaped occurrences: a quoted string literal in an href/destination
        // position. Prose in comments that explains the rename is documentation, not a
        // link — and this change deliberately left some of it.
        if (linkish.test(text) || pushy.test(text)) {
          offenders.push(`${path.relative(srcDir, full)} → ${RETIRED_ROUTE}`);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  it('🔴 POSITIVE CONTROL for the link walk: it CAN find a link', () => {
    // The walk above returning `[]` is indistinguishable from a walk whose regexes match
    // nothing. Feed the same two patterns a string they MUST hit. Without this the whole
    // sweep is a reassuring zero — the exact failure mode a redirect guard is worst at,
    // because a missed link still WORKS (via the redirect) and so is never reported.
    const sample = `<Link href="/apps/installed">x</Link>; router.push('/apps/installed');`;
    expect(
      new RegExp(`(?:href|destination)\\s*[=:]\\s*['"]${RETIRED_ROUTE}['"]`).test(sample)
    ).toBe(true);
    expect(
      new RegExp(`router\\.(?:push|replace)\\(\\s*['"]${RETIRED_ROUTE}['"]`).test(sample)
    ).toBe(true);
    // …and that the walk reaches a plausible number of files.
    let count = 0;
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (name.isDirectory()) {
          if (name.name === 'node_modules' || name.name === '__screenshots__') continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(name.name)) count += 1;
      }
    };
    walk(path.resolve(__dirname, '../..'));
    expect(count).toBeGreaterThan(500);
  });
});
