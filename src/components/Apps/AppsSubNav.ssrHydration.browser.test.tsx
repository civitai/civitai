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
 * WHY THIS MATTERS FOR THIS CHANGE. `Create` is now gated on
 * `isAppDeveloper(currentUser, { appBlocksAuthor: features.appBlocksAuthor })`, and
 * that gate is deliberately NOT deferred behind `useIsClient()` — the claim being that
 * both inputs are SSR-seeded and frozen, so applying them on the first paint is safe.
 * This file is where that claim gets exercised end-to-end instead of asserted.
 */

type Summary = {
  hasInstalls: boolean;
  hasSubmissions: boolean;
  hasApprovedApps: boolean;
  isReviewer: boolean;
};

const ALL_TRUE: Summary = {
  hasInstalls: true,
  hasSubmissions: true,
  hasApprovedApps: true,
  isReviewer: true,
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

  test('NON-AUTHOR (app-listings tester): no bar in the server HTML, and hydration is clean', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.user = { id: 7, username: 'tester', isModerator: false };

    // SERVER: the protected summary query has not resolved.
    mocks.navSummary = undefined;
    const html = renderToString(subNav());
    // A non-author with no summary qualifies for Marketplace alone ⇒ nothing renders.
    expect(html).not.toContain('role="tab"');

    // CLIENT: the query data IS in the cache on the very first render — the exact
    // condition that bailed hydration before the `useIsClient` gate existed.
    mocks.navSummary = { ...ALL_TRUE };
    await hydrateInto(html, subNav());

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
  });

  test('AUTHOR: Create IS in the server HTML (the gate applies pre-hydration) and hydration is clean', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: true };
    mocks.user = { id: 7, username: 'author', isModerator: false };
    mocks.navSummary = undefined;

    const html = renderToString(subNav());
    // 🔴 The load-bearing observation: `appBlocksAuthor` is available DURING SSR, so
    // the author tab is in the server HTML. That is what makes gating it WITHOUT the
    // `useIsClient` deferral correct rather than lucky.
    expect(html).toContain('/apps/submit');
    expect(html).toContain('Create');
    // …while the summary-driven tabs are NOT (those are still deferred).
    expect(html).not.toContain('/apps/installed');
    expect(html).not.toContain('/apps/review');

    mocks.navSummary = { ...ALL_TRUE };
    await hydrateInto(html, subNav());

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
  });

  test('MODERATOR with appBlocksAuthor=false: the mod floor is server-rendered and hydration is clean', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.user = { id: 1, username: 'mod', isModerator: true };
    mocks.navSummary = undefined;

    const html = renderToString(subNav());
    expect(html).toContain('/apps/submit');

    mocks.navSummary = { ...ALL_TRUE };
    await hydrateInto(html, subNav());

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
  });

  test('logged-out: the server renders no bar, and hydration is clean', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: true };
    mocks.user = null;
    mocks.navSummary = undefined;

    const html = renderToString(subNav());
    expect(html).not.toContain('role="tab"');

    await hydrateInto(html, subNav());

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
  });
});
