import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import (NOT `typeof import('...')`, which
// @typescript-eslint/consistent-type-imports rejects) so the spread below keeps the
// real module's type.
import type * as TrpcMod from '~/utils/trpc';

/**
 * Regression: `AppsSubNav` HYDRATION SAFETY (prod incident — every /apps page inert).
 *
 * The conditional sub-nav tabs (Installed / My submissions / Revenue / Review) are
 * driven by the client-only `blocks.getNavSummary` query. tRPC runs with `ssr:false`,
 * so the SERVER always renders the always-on set (`EMPTY_SUMMARY`), while the query's
 * data is present in the CLIENT's FIRST render. For a user with
 * installs/submissions/approved-apps/reviewer status the first client paint rendered
 * 6 tabs against the server's 2 — a React hydration mismatch (#418/#425) that bailed
 * hydration of the ENTIRE /apps page ROOT, leaving every /apps page un-hydrated and
 * inert (dead buttons; the `/apps/submit?edit=` query never fired → a permanent
 * "Loading your listing…").
 *
 * The fix gates the SUMMARY-driven tabs on `useIsClient()` (false on the server AND
 * the first client paint, true only AFTER mount) so the server render and the first
 * client render are IDENTICAL — those tabs reveal only post-hydration.
 *
 * ── THE AUTHOR GATE IS DELIBERATELY *NOT* `isClient`-DEFERRED ────────────────────
 * `Create` now renders only for `isAuthor` (`isAppDeveloper(user, { appBlocksAuthor })`).
 * Both of that predicate's inputs are SSR-seeded and FROZEN — `features.appBlocksAuthor`
 * comes from `pageProps.flags` (resolved server-side in `_app.getInitialProps`, frozen
 * by `useState(initialFlags)`; it is NOT a `toggleable` flag so the client
 * `user.getFeatureFlags` overlay cannot move it), and `isModerator` rides
 * `SessionProvider`'s `useState(initial)` seed. So it is safe on the FIRST paint, and
 * these tests pin the distinction: the summary tabs stay deferred, the author tab does
 * not, and the pre-mount output must not vary with the query's data.
 *
 * These tests drive the `AppsSubNav` CONTAINER (not the pure `AppsSubNavView`) so the
 * `useIsClient` gate + the `isAppDeveloper` derivation are both exercised.
 * (The REAL `renderToString` → `hydrateRoot` check, with a console.error positive
 * control, lives in `AppsSubNav.ssrHydration.browser.test.tsx`.)
 */

const ALL_TRUE_SUMMARY = {
  hasInstalls: true,
  hasSubmissions: true,
  hasApprovedApps: true,
  isReviewer: true,
};

const mocks = vi.hoisted(() => ({
  // Controls `useIsClient()` — false simulates the server + the first client paint
  // (pre-mount), true simulates a post-mount render.
  isClient: false,
  // The resolved `getNavSummary` data available to the CLIENT render.
  navSummary: undefined as undefined | typeof ALL_TRUE_SUMMARY,
  // `useFeatureFlags()` — SSR-seeded + frozen in the real provider.
  flags: { appBlocks: true, appBlocksAuthor: true } as Record<string, boolean>,
  // `useCurrentUser()` — SSR-seeded via SessionProvider; `null` = logged out.
  user: null as null | { id: number; username: string; isModerator?: boolean },
}));

vi.mock('~/providers/IsClientProvider', () => ({
  useIsClient: () => mocks.isClient,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => mocks.flags,
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.user,
}));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-
// mock): a hand-written replacement silently breaks every importer the day
// '~/utils/trpc' grows an export this factory omits — the whole FILE then fails to
// load with 0 tests collected and no failing assertion.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: { blocks: { getNavSummary: { useQuery: () => ({ data: mocks.navSummary }) } } },
}));

const { AppsSubNav } = await import('./AppsSubNav');

function tab(name: string) {
  return page.getByRole('tab', { name });
}

/** The tab labels currently in the document, in DOM order. */
function renderedTabs(): string[] {
  return page
    .getByRole('tab')
    .elements()
    .map((el) => (el.textContent ?? '').trim());
}

/**
 * 🔴 RENDER BARRIER — required before every "renders nothing" assertion.
 *
 * `render()` commits through a React 18 concurrent root on a LATER task, so a
 * synchronous `expect(renderedTabs()).toEqual([])` right after `renderWithProviders`
 * reads an EMPTY container and passes whatever the component does. Caught by mutation:
 * deleting the `links.length < 2` hide left these tests green until the barrier was
 * added. Render the sentinel alongside the component and AWAIT it first.
 */
const RENDER_BARRIER = 'render-barrier';
const RenderBarrier = () => <div data-testid={RENDER_BARRIER} />;

/** Render `AppsSubNav` behind a render barrier and wait for the commit. */
async function renderSubNav() {
  renderWithProviders(
    <>
      <RenderBarrier />
      <AppsSubNav />
    </>
  );
  await expect.element(page.getByTestId(RENDER_BARRIER)).toBeInTheDocument();
}

const CONDITIONAL = ['Installed', 'My submissions', 'Revenue', 'Review'] as const;

beforeEach(() => {
  mocks.isClient = false;
  // Simulate the query data being present on the client (the prod condition): a user
  // whose summary is fully populated.
  mocks.navSummary = { ...ALL_TRUE_SUMMARY };
  // Default viewer: an AUTHOR (this is the shape the original incident was found in —
  // a mod), so the pre-mount set is the two-tab bar and the bar renders.
  mocks.flags = { appBlocks: true, appBlocksAuthor: true };
  mocks.user = { id: 1, username: 'dev', isModerator: false };
});

describe('AppsSubNav container — hydration-safe conditional tabs', () => {
  test('pre-mount (server + first client paint) renders ONLY the always-on tabs, even when the query already has a full summary', async () => {
    mocks.isClient = false; // server / first client paint
    await renderSubNav();

    // The always-on tabs render.
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    await expect.element(tab('Create')).toBeInTheDocument();

    // The conditional tabs MUST NOT render pre-mount — this is what keeps the first
    // client paint identical to the SSR HTML (the fix). Before the fix, the query
    // data leaked into the first render and produced these tabs → hydration mismatch.
    for (const name of CONDITIONAL) {
      expect(tab(name).elements()).toHaveLength(0);
    }
  });

  test('post-mount (isClient=true) reveals the conditional tabs from the summary', async () => {
    mocks.isClient = true; // after mount / hydration has matched
    await renderSubNav();

    for (const name of ['Marketplace', 'Create', ...CONDITIONAL]) {
      await expect.element(tab(name)).toBeInTheDocument();
    }
  });

  test('pre-mount with NO summary data also shows only the always-on tabs (server parity)', async () => {
    mocks.isClient = false;
    mocks.navSummary = undefined; // server: query never resolved
    await renderSubNav();

    await expect.element(tab('Marketplace')).toBeInTheDocument();
    await expect.element(tab('Create')).toBeInTheDocument();
    for (const name of CONDITIONAL) {
      expect(tab(name).elements()).toHaveLength(0);
    }
  });
});

/**
 * 🔴 SSR TAB SET ≡ FIRST CLIENT RENDER.
 *
 * The server render (query never resolved) and the first client paint (query data
 * already in the cache) are BOTH `isClient === false`. The invariant that keeps
 * hydration matching is that the pre-mount output must be a function of the SSR-seeded
 * inputs ONLY — the query's data must not be able to change it.
 *
 * Each cohort is asserted TWICE against the SAME pinned literal (once with the data
 * absent = the server, once with it present = the first client paint) rather than by
 * comparing one render to another: a pinned literal cannot be satisfied by two renders
 * that are equally wrong, and the AUTHOR pair below is deliberately NON-EMPTY so the
 * equality is not an `[] === []` that any broken render would also satisfy.
 */
describe('AppsSubNav container — SSR tab set === first client render', () => {
  const NON_AUTHOR = () => {
    // The widened store-visibility tester cohort, verified live: sees the store,
    // cannot author.
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.user = { id: 7, username: 'tester', isModerator: false };
  };
  const AUTHOR = () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: true };
    mocks.user = { id: 7, username: 'author', isModerator: false };
  };

  test('NON-AUTHOR, server render (no query data) → no bar at all', async () => {
    NON_AUTHOR();
    mocks.isClient = false;
    mocks.navSummary = undefined;
    await renderSubNav();
    expect(renderedTabs()).toEqual([]);
    expect(page.getByRole('tablist').elements()).toHaveLength(0);
  });

  test('NON-AUTHOR, first client paint (query data PRESENT) → the identical set', async () => {
    NON_AUTHOR();
    mocks.isClient = false;
    mocks.navSummary = { ...ALL_TRUE_SUMMARY }; // the prod condition that broke hydration
    await renderSubNav();
    expect(renderedTabs()).toEqual([]);
    expect(page.getByRole('tablist').elements()).toHaveLength(0);
  });

  test('AUTHOR, server render (no query data) → Marketplace + Create', async () => {
    AUTHOR();
    mocks.isClient = false;
    mocks.navSummary = undefined;
    await renderSubNav();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Create']);
  });

  test('AUTHOR, first client paint (query data PRESENT) → the identical set', async () => {
    AUTHOR();
    mocks.isClient = false;
    mocks.navSummary = { ...ALL_TRUE_SUMMARY };
    await renderSubNav();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    // Non-empty on BOTH sides of the pair: the author gate applied on the first
    // paint (Create is here pre-mount) while the summary gate did NOT (none of the
    // four conditional tabs leaked in).
    expect(renderedTabs()).toEqual(['Marketplace', 'Create']);
  });

  test('POSITIVE CONTROL: the same reader DOES see the conditional tabs post-mount', async () => {
    // Guards every `toEqual([])` above against being vacuously green — if
    // `renderedTabs()` were wired to nothing it would return `[]` here too.
    NON_AUTHOR();
    mocks.isClient = true;
    mocks.navSummary = { ...ALL_TRUE_SUMMARY };
    await renderSubNav();
    await expect.element(tab('Installed')).toBeInTheDocument();
    expect(renderedTabs()).toEqual([
      'Marketplace',
      'Installed',
      'My submissions',
      'Revenue',
      'Review',
    ]);
    // Create is the one tab the author gate removes.
    expect(renderedTabs()).not.toContain('Create');
  });
});

/**
 * The author-capability derivation IN THE CONTAINER — the half that
 * `AppsSubNavView` (props-only) cannot cover: that `AppsSubNav` feeds the shared
 * `isAppDeveloper(user, { appBlocksAuthor })` predicate, not an inlined check.
 */
describe('AppsSubNav container — the Create tab keys off isAppDeveloper', () => {
  beforeEach(() => {
    mocks.isClient = true; // post-mount, so the full tab set is observable
    mocks.navSummary = { ...ALL_TRUE_SUMMARY };
  });

  test('non-mod WITHOUT the author capability → no Create tab', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.user = { id: 7, username: 'tester', isModerator: false };
    await renderSubNav();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(tab('Create').elements()).toHaveLength(0);
  });

  test('non-mod WITH the author capability → Create tab', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: true };
    mocks.user = { id: 7, username: 'author', isModerator: false };
    await renderSubNav();
    await expect.element(tab('Create')).toBeInTheDocument();
  });

  test('🔴 MODERATOR FLOOR: a mod keeps Create even with appBlocksAuthor=false', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.user = { id: 1, username: 'mod', isModerator: true };
    await renderSubNav();
    await expect.element(tab('Create')).toBeInTheDocument();
  });

  test('the flag being ABSENT entirely behaves as false for a non-mod', async () => {
    // Flipt-down / flag-not-yet-created: `appBlocksAuthor` is simply missing.
    mocks.flags = { appBlocks: true };
    mocks.user = { id: 7, username: 'tester', isModerator: false };
    await renderSubNav();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(tab('Create').elements()).toHaveLength(0);
  });

  test('a logged-out viewer never gets Create, even if the flag reads true', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: true };
    mocks.user = null;
    mocks.navSummary = undefined; // the summary query is protected — no data for anon
    await renderSubNav();
    // Marketplace alone ⇒ the whole bar is hidden.
    expect(page.getByRole('tablist').elements()).toHaveLength(0);
    expect(tab('Create').elements()).toHaveLength(0);
  });
});

/** The <2-tab collapse, driven through the container. */
describe('AppsSubNav container — hides entirely below two tabs', () => {
  test('a non-author with an empty summary renders no nav at all', async () => {
    mocks.isClient = true;
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.user = { id: 7, username: 'tester', isModerator: false };
    mocks.navSummary = {
      hasInstalls: false,
      hasSubmissions: false,
      hasApprovedApps: false,
      isReviewer: false,
    };
    await renderSubNav();
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
    expect(page.getByRole('tablist').elements()).toHaveLength(0);
  });

  test('one install is enough to bring the bar back', async () => {
    mocks.isClient = true;
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.user = { id: 7, username: 'tester', isModerator: false };
    mocks.navSummary = {
      hasInstalls: true,
      hasSubmissions: false,
      hasApprovedApps: false,
      isReviewer: false,
    };
    await renderSubNav();
    await expect.element(page.getByRole('navigation', { name: 'App sections' })).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Installed']);
  });
});
