import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import (NOT `typeof import('...')`, which
// @typescript-eslint/consistent-type-imports rejects) so the spread below keeps the real
// module's type.
import type * as TrpcMod from '~/utils/trpc';

/**
 * 🔒 `AppActivityPanel` — the `App` column's name link, and its STORE gate.
 *
 * ── THE DEFECT CLASS THIS PINS ────────────────────────────────────────────────
 * The name links to `/apps/store-preview/<slug>`. That route
 * `getServerSideProps`-gates on `resolveAppsPageAccess` → `hasAppsStoreAccess` and
 * returns `notFound`, and `appListings.getAppDetail` resolves a `StoreVisibilityScope`
 * of `none` and throws NOT_FOUND. So an UNGATED link is an affordance into a 404 — the
 * class civitai#4668 shipped and civitai#4685 exists to prevent, and the reason
 * `AppNameCrumb` already solves this exact problem the exact same way.
 *
 * 🔴 EVERY TEST HERE IS RED ON PRE-CHANGE CODE, but for two DIFFERENT reasons, and only
 * one of them is the gate:
 *   · the `plain text` cases were red because `origin/main` rendered a plain `<Text>`
 *     with NO testid at all, so the query found nothing — i.e. they are red for the
 *     absence of the feature, not for the gate;
 *   · the `link` case is the one that fails if the gate is DELETED while the feature
 *     exists, which is the mutation the acceptance criterion names.
 * Both directions are asserted because a gate that hides the link from EVERYONE passes
 * the first set and is just as wrong.
 *
 * ── THE MUTATION CHECK ────────────────────────────────────────────────────────
 * Deleting `!canSeeStore ||` from `ActivityAppName`'s early return makes
 * `🔴 an ineligible viewer gets PLAIN TEXT, not a link` fail on its OWN assertion —
 * `expect(el.tagName, 'an ineligible viewer must not be given an anchor').not.toBe('A')`
 * — rather than on another test's error. MEASURED, not asserted:
 *
 *   AssertionError: an ineligible viewer must not be given an anchor:
 *   expected 'A' not to be 'A' // Object.is equality
 *
 * and `🔴 FAILS CLOSED with no FeatureFlags provider at all` dies alongside it, on the
 * same claim from the `null`-flags direction. The three eligible-viewer tests stay
 * GREEN under that mutant, which is what makes the red attributable to the gate.
 *
 * ── WHY THE FLAGS ARE MOCKED AT THE PROVIDER ─────────────────────────────────
 * The component reads `useOptionalFeatureFlags()`, which is `useContext` — outside a
 * provider it returns `null`, and `hasAppsStoreAccess(null)` is `false`. Stubbing the
 * hook is what lets the ELIGIBLE arm exist at all; the `null` behaviour (fail closed)
 * gets its own test with the hook returning `null` explicitly.
 */

type ScopeRow = {
  id: string;
  createdAt: Date;
  appBlockId: string;
  appName: string;
  appSlug: string | null;
  scope: string;
  endpoint: string;
  statusCode: number;
  detail: null;
};

const ROW: ScopeRow = {
  id: 'sc_1',
  createdAt: new Date(Date.now() - 20 * 60 * 1000), // 20 minutes ago
  appBlockId: 'apb_1',
  appName: 'Lighthouse',
  appSlug: 'lighthouse',
  scope: 'buzz:read:self',
  endpoint: 'me',
  statusCode: 200,
  detail: null,
};

const mocks = vi.hoisted(() => ({
  flags: null as null | Record<string, boolean>,
  // Mutable so a test can drive the EMPTY-state branch (the marketplace-CTA gate) and
  // the unresolvable-listing branch (`appSlug: null`) without a second mock factory.
  scopeRows: undefined as unknown[] | undefined,
}));

// `DaysFromNow` reads `useIsClient()` from this provider and THROWS outside it;
// `renderWithProviders` supplies Mantine + a QueryClient only. `true` is the post-mount
// value, which is the state every assertion here is about.
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => mocks.flags ?? {},
  useOptionalFeatureFlags: () => mocks.flags,
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-mock): a
// hand-written replacement silently breaks every other importer the day `~/utils/trpc` gains
// an export this factory omits — the whole FILE then fails to load, 0 tests collected, no
// failing assertion.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const inert = {
    data: undefined,
    error: null,
    isLoading: false,
    isFetching: false,
    isPending: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  };
  const page1 = <T,>(items: T[]) => ({ ...inert, data: { pages: [{ items, nextCursor: null }] } });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: {
      blocks: {
        listMyAppActivity: { useInfiniteQuery: () => page1([]) },
        listMyScopeInvocations: { useInfiniteQuery: () => page1(mocks.scopeRows ?? [ROW]) },
      },
      modelVersion: { getVersionsByIds: { useQuery: () => ({ ...inert, data: [] }) } },
      useQueries: () => [],
    },
  };
});

const { AppActivityPanel } = await import('~/components/Apps/AppActivityPanel');

const appName = () => page.getByTestId('app-activity-app-name');

beforeEach(() => {
  mocks.flags = null;
  mocks.scopeRows = undefined;
});

describe('the App column links to the store detail — GATED', () => {
  test('🔴 an ineligible viewer gets PLAIN TEXT, not a link', async () => {
    // 🔴 THIS IS THE MUTATION-CHECKED ASSERTION. Delete `!canSeeStore ||` from
    // `ActivityAppName` and this test fails HERE, on the tag name and the missing
    // `href` — not on another test's error.
    mocks.flags = { appBlocks: false, appListings: false, appListingsPublicExternal: false };
    renderWithProviders(<AppActivityPanel />);
    await expect.element(appName()).toBeInTheDocument();
    const el = appName().element();
    // 🔴 ASSERTED AS "NOT AN ANCHOR, NO href" RATHER THAN AS A TAG LITERAL. Mantine's
    // `<Text>` renders a `<p>`, and pinning `'P'` would make this test about Mantine's
    // default element instead of about the gate. The claim that matters is that the
    // viewer is not handed a navigable link — and the `an eligible viewer` case below is
    // the positive control that keeps `not.toBe('A')` from being vacuous.
    expect(el.tagName, 'an ineligible viewer must not be given an anchor').not.toBe('A');
    expect(el.getAttribute('href'), 'a 404 affordance was rendered').toBeNull();
    expect(el.textContent).toContain('Lighthouse');
  });

  test('🔴 FAILS CLOSED with no FeatureFlags provider at all', async () => {
    // `useOptionalFeatureFlags` returns `null` outside its provider, and
    // `hasAppsStoreAccess(null)` is `false`. The absence of flags must REMOVE the
    // affordance, never grant it — the reason this component uses the optional hook.
    mocks.flags = null;
    renderWithProviders(<AppActivityPanel />);
    await expect.element(appName()).toBeInTheDocument();
    expect(appName().element().tagName).not.toBe('A');
    expect(appName().element().getAttribute('href')).toBeNull();
  });

  test('an eligible viewer gets a REAL link to getListingDetailHref(slug)', async () => {
    // 🔴 THE OTHER DIRECTION. Without this, a gate that hid the link from everyone —
    // or a component that never renders one — passes the two tests above.
    mocks.flags = { appListings: true };
    renderWithProviders(<AppActivityPanel />);
    await expect.element(appName()).toBeInTheDocument();
    const el = appName().element();
    expect(el.tagName).toBe('A');
    // The canonical helper's output, asserted as a LITERAL rather than by calling the
    // helper — deriving the expectation from the implementation would pass whatever it
    // produced.
    expect(el.getAttribute('href')).toBe('/apps/store-preview/lighthouse');
  });

  // The gate is `hasAppsStoreAccess`, a three-way OR. Asserting ONE flag would not see a
  // mutant that dropped the other two. `test.each` rather than a loop inside one test:
  // the harness unmounts between TESTS, and re-rendering into an already-mounted
  // container inside one test finds nothing.
  test.each(['appListings', 'appBlocks', 'appListingsPublicExternal'])(
    '%s ALONE opens the link',
    async (flag) => {
      mocks.flags = { [flag]: true };
      renderWithProviders(<AppActivityPanel />);
      await expect.element(appName()).toBeInTheDocument();
      expect(appName().element().tagName, `${flag} alone should open the link`).toBe('A');
    }
  );
});

/**
 * 🔒 A ROW WITH NO RESOLVABLE LISTING GETS PLAIN TEXT — the half of `AppNameCrumb` this
 * component did NOT copy.
 *
 * The crumb withholds its link on TWO conditions: the flag gate AND the listing failing
 * to resolve ("Omitted → no store cluster … not a broken link"). `ActivityAppName` copied
 * only the flag half, and the server made that fatal: both feeds emitted
 * `appSlug: r.appBlock?.blockId ?? r.appBlockId`, whose fallback is the AppBlock PRIMARY
 * KEY, not the `block_id` that `AppListing.slug` mirrors. So an unresolved join produced
 * `/apps/store-preview/<pk>` — a link that can only 404. The service now emits `null`
 * there (see "the appSlug contract" in `user-app-surface.service`), and this pins the
 * consumer's side of that contract.
 */
describe('a row whose listing does not resolve (appSlug: null)', () => {
  test('🔴 renders PLAIN TEXT, not a link, for an ELIGIBLE viewer', async () => {
    // 🔴 THE VIEWER IS ELIGIBLE ON PURPOSE. With `appListings: false` this would pass for
    // the flag gate's reason and say nothing about the slug, which is the whole point.
    mocks.flags = { appListings: true };
    mocks.scopeRows = [{ ...ROW, appSlug: null }];
    renderWithProviders(<AppActivityPanel />);
    await expect.element(appName()).toBeInTheDocument();
    const el = appName().element();
    expect(el.tagName, 'a row with no listing slug must not be given an anchor').not.toBe('A');
    expect(el.getAttribute('href')).toBeNull();
    // The name still shows — withholding the LINK must not withhold the identity.
    expect(el.textContent).toContain('Lighthouse');
  });

  test('🔴 …and the slug BADGE is dropped rather than printing the primary key', async () => {
    // The badge rendered `item.appSlug` unconditionally, so on the same rows it printed
    // the AppBlock id as though it were the app's public slug.
    mocks.flags = { appListings: true };
    mocks.scopeRows = [{ ...ROW, appSlug: null }];
    renderWithProviders(<AppActivityPanel />);
    await expect.element(appName()).toBeInTheDocument();
    const cell = document.querySelector('table tbody tr:first-child > td:nth-child(2)');
    expect(cell, 'no App cell').not.toBeNull();
    expect(cell!.textContent?.trim()).toBe('Lighthouse');
    // POSITIVE CONTROL for the line above: with a real slug the badge IS rendered, so
    // this is not an assertion satisfied by a badge that never renders at all.
    expect(cell!.textContent).not.toContain('apb_1');
  });

  test('POSITIVE CONTROL: with a real slug the badge renders beside the link', async () => {
    mocks.flags = { appListings: true };
    renderWithProviders(<AppActivityPanel />);
    await expect.element(appName()).toBeInTheDocument();
    const cell = document.querySelector('table tbody tr:first-child > td:nth-child(2)');
    expect(cell!.textContent).toContain('lighthouse');
    expect(appName().element().tagName).toBe('A');
  });
});

/**
 * 🔒 THE PER-APP DRILL-DOWN SUPPRESSES THE LINK ENTIRELY — `linkable={!appBlockId}`.
 *
 * The drill-down caller is the run-frame's "Permissions & activity" drawer, mounted OVER
 * A RUNNING FULL-PAGE APP. A top-level `<a>` there navigates the whole window out of the
 * app the user is using, from a panel they opened to READ — and the column is redundant
 * in that mode anyway, since every row is the same app. Asserted for an ELIGIBLE viewer
 * with a REAL slug, so neither the flag gate nor a null slug can be the reason it passes.
 */
describe('per-app drill-down: the App name is never a top-level navigation', () => {
  test('🔴 appBlockId set ⇒ plain text, even for an eligible viewer with a real slug', async () => {
    mocks.flags = { appListings: true };
    renderWithProviders(<AppActivityPanel appBlockId="apb_1" />);
    await expect.element(appName()).toBeInTheDocument();
    const el = appName().element();
    expect(
      el.tagName,
      'the drawer must not offer a link that navigates out of the running app'
    ).not.toBe('A');
    expect(el.getAttribute('href')).toBeNull();
    expect(el.textContent).toContain('Lighthouse');
  });

  test('POSITIVE CONTROL: the SAME viewer + row DOES get a link on the whole-account feed', async () => {
    // Identical flags, identical row — only `appBlockId` differs. Without this the test
    // above would pass against a component that never links.
    mocks.flags = { appListings: true };
    renderWithProviders(<AppActivityPanel />);
    await expect.element(appName()).toBeInTheDocument();
    expect(appName().element().tagName).toBe('A');
  });
});

/**
 * 🔒 THE EMPTY STATE'S `/apps` ANCHOR IS STORE-GATED.
 *
 * `/apps` SSR-gates on `hasAppsStoreAccess` = `appListings || appBlocks ||
 * appListingsPublicExternal`. `appBlocksPages` is NOT one of those disjuncts, while
 * `/apps/activity` now admits `appBlocks || appBlocksPages` — so the cohort this PR
 * widened the page for could reach this empty state and be handed a link the marketplace
 * answers `notFound` for. Same 404-affordance class as the `App` column above.
 *
 * ── THE MUTATION CHECK ──────────────────────────────────────────────────────
 * Delete the `canSeeStore &&` guard from `EmptyActivity` and the first test here fails on
 * its OWN assertion (the anchor it asserts absent is present); the positive control below
 * stays green, which is what attributes the red to the gate rather than to the render.
 */
describe('the empty state offers /apps only to a viewer /apps would serve', () => {
  const cta = () => document.querySelectorAll('a[href="/apps"]');

  test('🔴 a page-apps-only viewer gets NO marketplace link', async () => {
    // The exact newly-admitted cohort: the page's gate passes on `appBlocksPages`, the
    // store's does not pass at all.
    mocks.flags = { appBlocks: false, appBlocksPages: true, appListings: false };
    mocks.scopeRows = [];
    renderWithProviders(<AppActivityPanel />);
    await expect.element(page.getByText(/No activity yet/)).toBeInTheDocument();
    expect(cta(), 'a link into a `notFound` was rendered for a store-less viewer').toHaveLength(0);
  });

  test('POSITIVE CONTROL: a store-visible viewer still gets it', async () => {
    // Without this, "no anchor" would also be satisfied by an empty state that lost its
    // CTA for everyone.
    mocks.flags = { appListings: true };
    mocks.scopeRows = [];
    renderWithProviders(<AppActivityPanel />);
    await expect.element(page.getByText(/No activity yet/)).toBeInTheDocument();
    expect(cta()).toHaveLength(1);
  });

  test('FAILS CLOSED with no FeatureFlags provider at all', async () => {
    mocks.flags = null;
    mocks.scopeRows = [];
    renderWithProviders(<AppActivityPanel />);
    await expect.element(page.getByText(/No activity yet/)).toBeInTheDocument();
    expect(cta()).toHaveLength(0);
  });
});

describe('the When column is RELATIVE, and the absolute instant survives on the <time>', () => {
  test('🔴 renders a relative string, not a YYYY-MM-DD HH:mm stamp', async () => {
    mocks.flags = { appListings: true };
    renderWithProviders(<AppActivityPanel />);
    await expect.element(appName()).toBeInTheDocument();
    const when = document.querySelector('table tbody tr:first-child > td');
    expect(when, 'no first cell').not.toBeNull();
    const text = when!.textContent ?? '';
    // dayjs `fromNow()` for a 20-minute-old row.
    expect(text).toMatch(/ago$/);
    // 🔴 NEGATIVE CONTROL for the line above: `/ago$/` would also match a cell that
    // happened to end in those letters. The absolute stamp `origin/main` rendered must
    // be GONE from the visible text.
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test('🔴 the absolute instant survives — as `title` AND as `datetime`', async () => {
    // The relative string is the readable half; losing the exact instant would make the
    // audit feed unusable for the question it exists to answer.
    mocks.flags = { appListings: true };
    renderWithProviders(<AppActivityPanel />);
    await expect.element(appName()).toBeInTheDocument();
    const time = document.querySelector('table tbody tr:first-child > td time');
    expect(time, 'DaysFromNow should render a <time> element').not.toBeNull();
    // `DaysFromNow` puts the formatted instant on both attributes.
    expect(time!.getAttribute('datetime')).toBeTruthy();
    expect(time!.getAttribute('title')).toBeTruthy();
    const cell = document.querySelector('table tbody tr:first-child > td');
    expect(cell!.firstElementChild).not.toBeNull();
  });

  /**
   * 🔴 ONE HOVER, ONE TOOLTIP. The cell used to wrap `DaysFromNow` in a Mantine
   * `Tooltip label={item.createdAt.toString()}`, while `DaysFromNow` renders its own
   * `<time title={day.format()}>`. Both fire on the SAME hover, and they format the same
   * instant differently (`Date.prototype.toString()` — "Mon Sep 08 2026 14:05:00 GMT+0000
   * (Coordinated Universal Time)" — vs dayjs `format()` — "2026-09-08T14:05:00+00:00"), so
   * a reader got two boxes disagreeing about how to spell one time.
   *
   * 🔴 IT HAS TO BE A HOVER, AND THE FIRST VERSION OF THIS GUARD WAS VACUOUS BECAUSE IT
   * WAS NOT. Asserting the DOM at render time — counting `[title]` nodes in the cell, or
   * looking for `aria-describedby` — cannot see this at all: a CLOSED Mantine `Tooltip`
   * adds no attribute and no element, so the wrapped and unwrapped markup are IDENTICAL
   * until someone hovers. Measured: with the `<Tooltip>` re-added around `DaysFromNow`,
   * the structural version passed 17/17. Only the floating surface it mounts ON HOVER
   * distinguishes them, so that is what is asserted.
   *
   * The poll is bounded and its discriminating power is measured, not assumed: under the
   * re-added wrapper `role="tooltip"` appears well inside the window (Mantine's default
   * `openDelay` is 0), and the guard fails on its own assertion.
   */
  test('🔴 hovering the When cell raises NO second tooltip over the native one', async () => {
    mocks.flags = { appListings: true };
    renderWithProviders(<AppActivityPanel />);
    await expect.element(appName()).toBeInTheDocument();

    const time = document.querySelector('table tbody tr:first-child > td time');
    expect(time, 'DaysFromNow should render a <time> element').not.toBeNull();
    // The native affordance the row genuinely owns — asserted first so "no tooltip
    // appeared" cannot be satisfied by a cell that lost its hover text entirely.
    expect(time!.getAttribute('title')).toBeTruthy();

    // `withinPortal` is Mantine's default, so a raised tooltip lands on `document.body`
    // rather than inside the cell — query the document.
    await page.getByText(/ago$/).hover();
    let raised: string[] = [];
    for (let i = 0; i < 20; i++) {
      raised = Array.from(document.querySelectorAll('[role="tooltip"]')).map(
        (el) => el.textContent ?? ''
      );
      if (raised.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      raised,
      'a second tooltip was re-added over `DaysFromNow`, which already owns `title` — ' +
        'one hover then shows the same instant twice, in two different formats'
    ).toEqual([]);
  });
});
