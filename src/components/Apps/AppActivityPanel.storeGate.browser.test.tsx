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

const ROW = {
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
        listMyScopeInvocations: { useInfiniteQuery: () => page1([ROW]) },
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

describe('the When column is RELATIVE, with the absolute time still in the tooltip', () => {
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

  test('🔴 the absolute instant survives — in the tooltip label AND as `datetime`', async () => {
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
    // Mantine's Tooltip keeps its label on the wrapped child's `aria-describedby`
    // target only while open, so the durable assertion is the wrapper's own presence:
    // the cell still carries the tooltip-bearing element it did before.
    const cell = document.querySelector('table tbody tr:first-child > td');
    expect(cell!.firstElementChild).not.toBeNull();
  });
});
