import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { getRedirectStatus } from 'next/dist/lib/redirect-status';
import { prepareDestination } from 'next/dist/shared/lib/router/utils/prepare-destination';
import { MY_APPS_HREF } from '~/shared/constants/apps-build.constants';

/**
 * The `/apps/build` consolidation, as REAL redirects rather than stub pages.
 *
 * Four retired routes land on one: `/apps/get-started` (static marketing whose every CTA
 * pointed off-platform), `/apps/mine` (the author table, now state C),
 * `/apps/my-submissions` (which used to land on `/apps/mine`), and `/apps/assistant` (the App
 * Assistant, which `/apps/build` now renders for the viewers its gate admits).
 *
 * 🔴 THIS READS THE ACTUAL `next.config.mjs` EXPORT AND CALLS `redirects()`. A text scan of
 * the file would pass on a commented-out entry, on an entry in the wrong array, and on one
 * whose object never reaches the returned list — all three of which look right in a diff.
 * Invoking the function is the only check that the rule is one Next will actually serve.
 *
 * The page components are DELETED, not emptied. A stub whose only job is to redirect is dead
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

const RETIRED_ROUTES = [
  '/apps/my-submissions',
  '/apps/mine',
  '/apps/get-started',
  '/apps/assistant',
] as const;

/**
 * Where each retired route lands. 🔴 The two "my apps" routes land on the app LIST
 * (`?view=apps`), not bare `/apps/build`: the page renders the App Assistant for every viewer it
 * admits to it, authors included, so a bare destination would open an author's "My apps"
 * bookmark on the assistant. Literal values, not the constant, so a wrong constant cannot pass.
 */
const DESTINATIONS: Record<(typeof RETIRED_ROUTES)[number], string> = {
  '/apps/my-submissions': '/apps/build?view=apps',
  '/apps/mine': '/apps/build?view=apps',
  '/apps/get-started': '/apps/build',
  '/apps/assistant': '/apps/build',
};

describe('the /apps/build consolidation redirects', () => {
  it('POSITIVE CONTROL: the redirect list is populated and reachable', () => {
    // 🔴 Without this, every assertion below could be satisfied by a `find` over an empty
    // array producing `undefined` and a `toBeDefined()` that someone later softened. A
    // reassuring "no match" is indistinguishable from a probe wired to nothing.
    expect(Array.isArray(redirects)).toBe(true);
    expect(redirects.length).toBeGreaterThan(5);
    expect(redirects.some((r) => r.source === '/discord')).toBe(true);
  });

  it.each(RETIRED_ROUTES)('%s 301s to its /apps/build destination', (source) => {
    const rule = redirects.find((r) => r.source === source);
    expect(rule).toBeDefined();
    expect(rule!.destination).toBe(DESTINATIONS[source]);
    // 🔴 301, not `permanent: true` — Next maps `permanent` to 308, which preserves the
    // request METHOD. These are GET-only pages whose inbound links are bookmarks,
    // notification URLs and search results; 301 is the status those consumers cache and
    // rewrite on. The two options are mutually exclusive in Next's schema.
    expect(rule!.statusCode).toBe(301);
    expect(rule!.permanent).toBeUndefined();
  });

  /**
   * 🔴 `/apps/assistant?fork=<slug>` IS A LINK IN THE WILD — the Fork action emitted it until this
   * change — so the redirect must carry the query, or a fork link lands on the page and opens
   * nothing. Asserted through Next's OWN destination builder and status mapping, the two calls its
   * router makes for a matched redirect, rather than by reading the rule's fields: a destination
   * with its own query, or `has` conditions, would change what reaches the browser while every
   * field assertion above stayed green.
   */
  it('🔴 /apps/assistant keeps its query string through the 301', () => {
    const rule = redirects.find((r) => r.source === '/apps/assistant')!;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params: {},
      query: { fork: 'pose-board-2', ref: 'store-card' },
    });
    expect(parsedDestination.pathname).toBe('/apps/build');
    expect(parsedDestination.query).toEqual({ fork: 'pose-board-2', ref: 'store-card' });
    expect(getRedirectStatus(rule as never)).toBe(301);
    // Control: a destination carrying its own query does NOT come out as the inbound query alone,
    // so the assertion above can tell the two apart.
    const control = prepareDestination({
      appendParamsToQuery: false,
      destination: '/apps/build?view=apps',
      params: {},
      query: { fork: 'pose-board-2' },
    });
    expect(control.parsedDestination.query).not.toEqual({ fork: 'pose-board-2' });
  });

  it('the "my apps" redirects land on the same URL every in-app "My apps" link uses', () => {
    // `next.config.mjs` cannot import the TypeScript constant, so it spells the URL literally;
    // this is what keeps the two from drifting apart.
    expect(MY_APPS_HREF).toBe('/apps/build?view=apps');
    for (const source of ['/apps/mine', '/apps/my-submissions']) {
      expect(redirects.find((r) => r.source === source)!.destination).toBe(MY_APPS_HREF);
    }
  });

  /**
   * 🔴 THE "MY APPS" 301s KEEP THE INBOUND QUERY, AND ADD `view=apps` — the same passthrough the
   * `/apps/assistant` rule has, through the same two Next calls. A destination with a query must
   * still carry the inbound params (a notification's tracking params, an old bookmark's), and its
   * own `view` must win over an inbound one, or `/apps/mine?view=x` would open the assistant.
   */
  it.each(['/apps/mine', '/apps/my-submissions'])(
    '🔴 %s lands on the app list and keeps its query string',
    (source) => {
      const rule = redirects.find((r) => r.source === source)!;
      const { parsedDestination } = prepareDestination({
        appendParamsToQuery: false,
        destination: rule.destination,
        params: {},
        query: { ref: 'notification', tab: 'publishing' },
      });
      expect(parsedDestination.pathname).toBe('/apps/build');
      expect(parsedDestination.query).toEqual({
        ref: 'notification',
        tab: 'publishing',
        view: 'apps',
      });
      expect(getRedirectStatus(rule as never)).toBe(301);

      const overridden = prepareDestination({
        appendParamsToQuery: false,
        destination: rule.destination,
        params: {},
        query: { view: 'assistant' },
      });
      expect(overridden.parsedDestination.query).toEqual({ view: 'apps' });
    }
  );

  /**
   * 🔴 NO CHAIN. `/apps/my-submissions` used to point at `/apps/mine`, which is now itself
   * a redirect — so repointing only the two NEW rules and leaving that one would have made
   * it a two-hop 301→301. That costs a round trip, and some link-equity and
   * bookmark-rewriting consumers stop following after the first hop.
   *
   * Stated as a RELATIONSHIP rather than as three destination literals: it fails for ANY
   * `/apps/*` rule whose destination is itself a redirect source, including a future one.
   */
  it('🔴 no /apps/* redirect lands on another redirect', () => {
    const sources = new Set(redirects.map((r) => r.source));
    // By PATH: `/apps/build?view=apps` is a hop to `/apps/build` whatever its query says.
    const chained = redirects
      .filter((r) => r.source.startsWith('/apps/') && sources.has(r.destination.split('?')[0]))
      .map((r) => `${r.source} → ${r.destination} (itself a redirect)`);
    expect(chained).toEqual([]);
    // Guard-the-guard: a `sources` set built from an empty list makes the filter above
    // trivially empty. Prove the lookup can hit.
    expect(sources.has('/apps/mine')).toBe(true);
  });

  it('🔴 the page components are GONE — the redirects are not sitting behind dead code', () => {
    const pagesDir = path.resolve(__dirname, '../../pages/apps');
    expect(fs.existsSync(pagesDir)).toBe(true); // control: looking in the right place
    for (const file of ['my-submissions.tsx', 'mine.tsx', 'get-started.tsx', 'assistant.tsx']) {
      expect(fs.existsSync(path.join(pagesDir, file)), `${file} should be deleted`).toBe(false);
    }
    // …and the surviving route DOES have a page, so this is a merge and not a deletion.
    expect(fs.existsSync(path.join(pagesDir, 'build.tsx'))).toBe(true);
    // `/apps/submit` KEEPS its route — it is not part of the merge. Its `?edit=<listingId>`
    // deep link is what `getOwnerEditHref` resolves for every offsite listing, from the
    // store card and the listing-detail ⋮ menus. Deleting it would break those silently:
    // the card would render an Edit control pointing at a 404.
    expect(fs.existsSync(path.join(pagesDir, 'submit.tsx'))).toBe(true);
  });

  it('no in-app link still points at any retired route', () => {
    // A link to a redirected route costs a round trip and re-renders the whole shell. The
    // redirects are for BOOKMARKS and notification URLs already in the wild, not for links
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
        // This file names every retired route as DATA; so does the redirect config test's
        // own fixture set. Excluding self is what keeps the guard from reporting itself.
        if (full === __filename) continue;
        const text = fs.readFileSync(full, 'utf8');
        for (const route of RETIRED_ROUTES) {
          // Only LINK-shaped occurrences: a quoted string literal in an href/destination
          // position. Prose in comments that explains a retired route is documentation,
          // not a link — and there is a lot of it, deliberately.
          const linkish = new RegExp(`(?:href|destination)\\s*[=:]\\s*['"]${route}['"]`);
          const pushy = new RegExp(`router\\.(?:push|replace)\\(\\s*['"]${route}['"]`);
          if (linkish.test(text) || pushy.test(text)) {
            offenders.push(`${path.relative(srcDir, full)} → ${route}`);
          }
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
    const sample = `<Link href="/apps/mine">x</Link>; router.push('/apps/get-started');`;
    expect(new RegExp(`(?:href|destination)\\s*[=:]\\s*['"]/apps/mine['"]`).test(sample)).toBe(
      true
    );
    expect(
      new RegExp(`router\\.(?:push|replace)\\(\\s*['"]/apps/get-started['"]`).test(sample)
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
