import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IsClientProvider } from '~/providers/IsClientProvider';
// Type-only namespace import (NOT `typeof import('...')`, which
// @typescript-eslint/consistent-type-imports rejects) so the spread below keeps the
// real module's type.
import type * as TrpcMod from '~/utils/trpc';

/**
 * 🔴 THE REAL HYDRATION CHECK — `renderToString` → `hydrateRoot`, with a POSITIVE
 * CONTROL proving the detector can go red.
 *
 * Its sibling `AppsSubNav.hydration.browser.test.tsx` SIMULATES the two frames by
 * driving a mocked `useIsClient`. That pins the tab sets, but it never performs a
 * hydration — so a "no hydration warning" assertion there would be a probe wired to
 * nothing, i.e. a reassuring zero. This file does the actual thing: it renders the
 * component to an HTML string with the REAL `IsClientProvider` (server semantics),
 * plants that HTML in a container, hydrates it, and asserts React reported no
 * hydration recovery.
 *
 * DETECTOR = `hydrateRoot`'s `onRecoverableError`, which is exactly what React calls
 * on a hydration mismatch (and, as a bonus, providing it stops React's default
 * `reportError` from surfacing as an unhandled error in the run). A `console.error`
 * text match is kept as a SECOND, independent signal — the two fail differently, so a
 * change to React's warning text can't silently disarm both.
 *
 * `INSTRUMENT CHECK` below is the control for the detector itself: a component that
 * deliberately renders different markup on the server than on the client MUST make
 * both signals fire. Without it, "no mismatch" is indistinguishable from a spy
 * attached to nothing.
 *
 * WHY THIS MATTERS FOR THIS CHANGE. The `Build` row (`/apps/build`) is gated on
 * `canAccessAppsBuild(currentUser, features)` and `Marketplace` on
 * `hasAppsStoreAccess(features)`, and NEITHER is deferred behind `useIsClient()` — the
 * claim being that every input is SSR-seeded and frozen (neither `appBlocksAuthor` nor
 * `appBlocksGetStarted` is `toggleable`, so `computeUserFeatureFlagsOverlay` cannot move
 * them between the server render and the first client paint), so applying them on the
 * first paint is safe. This file is where that claim gets exercised end-to-end instead of
 * asserted.
 *
 * 🔴 EVERY HTML ASSERTION HERE WAS RE-DERIVED FOR THE `/apps/build` CONSOLIDATION. The
 * strings this file used to look for — `/apps/get-started` and `/apps/submit` — name
 * routes that no longer have a row (get-started is deleted and 301s to `/apps/build`;
 * submit kept its route and lost its tab), so they are now asserted ABSENT.
 */

type Summary = {
  hasInstalls: boolean;
  hasSubmissions: boolean;
  hasApprovedApps: boolean;
  isReviewer: boolean;
  hasEditableApps: boolean;
  hasPendingInvites: boolean;
};

const ALL_TRUE: Summary = {
  hasInstalls: true,
  hasSubmissions: true,
  hasApprovedApps: true,
  isReviewer: true,
  hasEditableApps: true,
  hasPendingInvites: true,
};

const mocks = vi.hoisted(() => ({
  navSummary: undefined as undefined | Summary,
  flags: { appBlocks: true, appBlocksAuthor: false } as Record<string, boolean>,
  user: null as null | { id: number; username: string; isModerator?: boolean },
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => mocks.flags,
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.user,
}));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-
// mock). The SERVER never has this query's data (tRPC runs with `ssr: false`); the
// CLIENT's very first render does. Driving it as a plain value lets the same tree be
// rendered under both conditions.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: { blocks: { getNavSummary: { useQuery: () => ({ data: mocks.navSummary }) } } },
}));

const { AppsSubNav } = await import('./AppsSubNav');

function Tree({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <IsClientProvider>{children}</IsClientProvider>
      </MantineProvider>
    </QueryClientProvider>
  );
}

/**
 * React's hydration-mismatch vocabulary (React 18). Deliberately NARROW — a broad
 * /hydrat/ matches MantineProvider's benign
 * "useLayoutEffect does nothing on the server … non-hydrated UI" SSR notice, which
 * fires on every server render of any Mantine tree and would make every test here
 * fail for a reason that has nothing to do with this component.
 */
const HYDRATION_RE =
  /(Hydration failed|An error occurred during hydration|The server HTML was replaced|Expected server HTML|did not match|Text content does not match)/i;

let consoleErrors: string[] = [];
let recoverable: string[] = [];
let restoreConsole: (() => void) | null = null;
const containers: HTMLElement[] = [];

beforeEach(() => {
  consoleErrors = [];
  recoverable = [];
  const original = console.error;
  console.error = ((...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    original.apply(console, args as []);
  }) as typeof console.error;
  restoreConsole = () => {
    console.error = original;
  };
  mocks.flags = { appBlocks: true, appBlocksAuthor: false };
  mocks.user = null;
  mocks.navSummary = undefined;
});

afterEach(() => {
  restoreConsole?.();
  restoreConsole = null;
  for (const c of containers.splice(0)) c.remove();
});

/** console.error lines that name a hydration problem (the SECOND signal). */
function hydrationConsoleErrors() {
  return consoleErrors.filter(
    (e) => HYDRATION_RE.test(e) && !/useLayoutEffect does nothing on the server/.test(e)
  );
}

/**
 * Plant `html` in a fresh container and hydrate it with `tree`, capturing every
 * recoverable error React reports.
 *
 * NO `act()`: React 18.3's `act` lives in `react-dom/test-utils`, which this repo's
 * `@types/react-dom` cannot resolve through its `exports` map (TS7016), and `React.act`
 * postdates the pinned `@types/react` (18.0.x). Instead we hydrate and then yield a few
 * macrotasks so React's scheduler runs the hydration + its passive effects. That is
 * only sound because the INSTRUMENT CHECK below would report ZERO recoverable errors if
 * the hydration had not actually run — so "no mismatch" cannot come from "nothing
 * happened".
 */
async function hydrateInto(html: string, tree: React.ReactElement) {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  containers.push(container);
  hydrateRoot(container, tree, {
    onRecoverableError: (err) => {
      recoverable.push(err instanceof Error ? err.message : String(err));
    },
  });
  // Hydration is scheduled, not synchronous. Yield until the DOM has been claimed
  // (or a bounded number of turns has passed, so a legitimately-empty render still
  // returns).
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return container;
}

const subNav = () => (
  <Tree>
    <AppsSubNav />
  </Tree>
);

/** Routes that had a row until the `/apps/build` consolidation retired it. */
const RETIRED_ROUTES = ['/apps/get-started', '/apps/mine', '/apps/submit'] as const;

/**
 * The bar's OWN markers in a server-rendered string.
 *
 * 🔴 WHY NOT `expect(html).toBe('')` FOR THE "NO BAR" CASES — THAT ASSERTION WOULD BE A
 * FALSE RED, and it was written that way before being checked. `MantineProvider` renders
 * two `<style data-mantine-styles>` elements of its own (`MantineClasses` and
 * `MantineCssVariables`, both default-on — read out of the installed @mantine/core
 * 7.17.8), so the server HTML of this tree is NON-EMPTY even when `AppsSubNav` returns
 * `null`. Absence is therefore asserted on markers this component alone emits, and as an
 * object so the failure message names WHICH marker survived rather than dumping a
 * stylesheet.
 */
function barMarkers(html: string) {
  return {
    landmark: html.includes('aria-label="App sections"'),
    build: html.includes('/apps/build'),
    marketplace: html.includes('/apps"'),
  };
}

describe('AppsSubNav — real SSR → hydrate', () => {
  test('🔴 INSTRUMENT CHECK: a genuine server/client divergence IS reported by BOTH signals', async () => {
    // Renders <p>server</p> on the server and <span>client</span> on the client —
    // exactly the class of divergence the /apps incident was. If this does not fire,
    // every "clean hydration" assertion below is meaningless.
    let onServer = true;
    function Diverges() {
      return onServer ? <p>server</p> : <span>client</span>;
    }
    const html = renderToString(<Diverges />);
    onServer = false;
    await hydrateInto(html, <Diverges />);

    expect(recoverable.length).toBeGreaterThan(0);
    expect(recoverable.join('\n')).toMatch(HYDRATION_RE);
    expect(hydrationConsoleErrors().length).toBeGreaterThan(0);
  });

  test('NON-AUTHOR with appBlocksGetStarted: Build IS server-rendered (the gate applies pre-hydration) and hydration is clean', async () => {
    // 🔴 THE GET-STARTED DISJUNCT OF `canAccessAppsBuild`, OBSERVED IN THE SERVER HTML.
    // `context.canBuild` is applied OUTSIDE the `useIsClient` deferral, which is only
    // correct because both of its capability terms are SSR-seeded and frozen (neither
    // flag is `toggleable`). That claim is checkable exactly here: the tab must be
    // present in the SERVER HTML, and hydrating a client whose summary cache is already
    // full must still produce no mismatch.
    //
    // The flag also keeps this cohort's set non-empty: without it a non-author with no
    // summary has `canBuild: false`, qualifies for Marketplace alone, and the `< 2`
    // collapse empties the HTML — which is a much weaker thing to assert (that cohort is
    // pinned by its own test below, and in the storeGate suite).
    mocks.flags = { appBlocks: true, appBlocksAuthor: false, appBlocksGetStarted: true };
    mocks.user = { id: 7, username: 'tester', isModerator: false };

    // SERVER: the protected summary query has not resolved.
    mocks.navSummary = undefined;
    const html = renderToString(subNav());
    expect(html).toContain('/apps/build');
    expect(html).toContain('/apps"'); // the Marketplace anchor
    // …while the SUMMARY-driven tabs are absent even though the client cache below is
    // full…
    expect(html).not.toContain('/apps/installed');
    expect(html).not.toContain('/apps/review');
    // …and no retired row came back. `/apps/get-started` in particular is now a 301 to
    // `/apps/build`, so a tab still pointing there would route every click through a
    // redirect.
    for (const route of RETIRED_ROUTES) {
      expect(html, `server HTML still links ${route}`).not.toContain(route);
    }

    // CLIENT: the query data IS in the cache on the very first render — the exact
    // condition that bailed hydration before the `useIsClient` gate existed.
    mocks.navSummary = { ...ALL_TRUE };
    await hydrateInto(html, subNav());

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
  });

  test('AUTHOR: Build IS in the server HTML (the author disjunct applies pre-hydration) and hydration is clean', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: true };
    mocks.user = { id: 7, username: 'author', isModerator: false };
    mocks.navSummary = undefined;

    const html = renderToString(subNav());
    // 🔴 The load-bearing observation: `appBlocksAuthor` is available DURING SSR, so
    // the build tab is in the server HTML. That is what makes gating it WITHOUT the
    // `useIsClient` deferral correct rather than lucky.
    expect(html).toContain('/apps/build');
    expect(html).toContain('Build');
    // …while the summary-driven tabs are NOT (those are still deferred) — including
    // `Invites`, the one row that reads BOTH the summary and `isAuthor`.
    expect(html).not.toContain('/apps/installed');
    expect(html).not.toContain('/apps/invites');
    expect(html).not.toContain('/apps/review');
    for (const route of RETIRED_ROUTES) {
      expect(html, `server HTML still links ${route}`).not.toContain(route);
    }

    mocks.navSummary = { ...ALL_TRUE };
    await hydrateInto(html, subNav());

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
  });

  test('MODERATOR with appBlocksAuthor=false: the mod floor is server-rendered and hydration is clean', async () => {
    // `canAccessAppsBuild` routes its author term through `isAppDeveloper`, where
    // `isModerator` is a hard floor — so a mod keeps Build with the capability off.
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.user = { id: 1, username: 'mod', isModerator: true };
    mocks.navSummary = undefined;

    const html = renderToString(subNav());
    expect(html).toContain('/apps/build');

    mocks.navSummary = { ...ALL_TRUE };
    await hydrateInto(html, subNav());

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
  });

  test('🔴 logged-out WITH appBlocksGetStarted + a store flag: Build IS server-rendered, and hydration is clean', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: false, appBlocksGetStarted: true };
    mocks.user = null;
    mocks.navSummary = undefined;

    const html = renderToString(subNav());
    // 🔴 `canBuild` IS NOT SESSION-SCOPED, and this is where that shows. The old version
    // of this test asserted the opposite half — that an anon viewer never got the
    // author-gated "Create" tab even with `appBlocksAuthor` true. "Create" is gone, and
    // the surviving `isAuthor`-gated row (`Invites`) is summary-driven, so it can never
    // appear in server HTML for anyone; there is nothing left to observe on that side.
    // What IS observable, and is the claim that matters for the consolidation: the
    // get-started term consults NO user, so `/apps/build` is offered to a logged-out
    // viewer — matching `resolveBuildPageAccess`, which would serve them state A.
    // Folding `canBuild` into the container's `currentUser ?` branch fails HERE.
    expect(html).toContain('/apps/build');
    expect(html).toContain('/apps"'); // Marketplace — the bar cleared the `< 2` floor
    for (const route of RETIRED_ROUTES) {
      expect(html, `server HTML still links ${route}`).not.toContain(route);
    }

    await hydrateInto(html, subNav());

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
  });

  test('🔴 DISCRIMINATING CONTROL: the same logged-out viewer WITHOUT get-started server-renders nothing', async () => {
    // Only `appBlocksGetStarted` moves between this and the test above. Without it an
    // anon non-author has `canBuild: false`, qualifies for Marketplace ALONE, and the
    // `< 2` collapse removes the bar — so the previous test's `toContain('/apps/build')`
    // is attributable to the flag rather than to "the component renders a Build tab for
    // everybody".
    mocks.flags = { appBlocks: true, appBlocksAuthor: false, appBlocksGetStarted: false };
    mocks.user = null;
    mocks.navSummary = undefined;

    const html = renderToString(subNav());
    expect(barMarkers(html)).toEqual({ landmark: false, build: false, marketplace: false });

    await hydrateInto(html, subNav());
    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
  });

  /**
   * 🔴 THE CONTAINER GATE IS STORE ACCESS ALONE NOW — a deliberate behaviour change,
   * observed at the SSR level.
   *
   * It used to read `!hasAppsStoreAccess(features) && !features.appBlocksGetStarted`, so
   * a get-started-only viewer got a server-rendered two-tab bar. Both of those tabs now
   * point somewhere that viewer cannot load — `/apps` gates on `resolveAppsPageAccess`
   * and `/apps/build` on `canAccessAppsBuild`, which ANDs store access — so the bar is
   * gone entirely for them. Both arms are in ONE test so the only difference between
   * them is the store flag.
   */
  test('🔴 appBlocksGetStarted WITHOUT store access → nothing is server-rendered (and hydration is still clean)', async () => {
    mocks.user = { id: 9, username: 'builder', isModerator: false };
    mocks.navSummary = undefined;

    mocks.flags = { appBlocks: false, appListings: false, appBlocksGetStarted: true };
    const noStoreHtml = renderToString(subNav());
    expect(barMarkers(noStoreHtml)).toEqual({ landmark: false, build: false, marketplace: false });

    // The control: the SAME viewer with a store flag lit does get the bar, so the absence
    // above is the gate firing and not the component being inert.
    mocks.flags = { appBlocks: false, appListings: true, appBlocksGetStarted: true };
    const withStoreHtml = renderToString(subNav());
    expect(barMarkers(withStoreHtml)).toEqual({ landmark: true, build: true, marketplace: true });

    // Hydrating the EMPTY server output against the no-store flags must still be clean —
    // the gate has to agree with itself across the two frames, or the change trades a
    // 404 for a hydration bail.
    mocks.flags = { appBlocks: false, appListings: false, appBlocksGetStarted: true };
    await hydrateInto(noStoreHtml, subNav());
    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
  });
});
