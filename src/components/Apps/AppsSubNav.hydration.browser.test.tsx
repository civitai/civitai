import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * Regression: `AppsSubNav` HYDRATION SAFETY (prod incident — every /apps page inert).
 *
 * The conditional sub-nav tabs (Installed / My submissions / Revenue / Review) are
 * driven by the client-only `blocks.getNavSummary` query. tRPC runs with `ssr:false`,
 * so the SERVER always renders the always-on set (`EMPTY_SUMMARY` → Marketplace +
 * Create), while the query's data is present in the CLIENT's FIRST render. For a user
 * with installs/submissions/approved-apps/reviewer status the first client paint
 * rendered 6 tabs against the server's 2 — a React hydration mismatch (#418/#425)
 * that bailed hydration of the ENTIRE /apps page ROOT, leaving every /apps page
 * un-hydrated and inert (dead buttons; the `/apps/submit?edit=` query never fired →
 * a permanent "Loading your listing…").
 *
 * The fix gates the conditional tabs on `useIsClient()` (false on the server AND the
 * first client paint, true only AFTER mount) so the server render and the first
 * client render are IDENTICAL — the conditional tabs reveal only post-hydration.
 *
 * These tests drive the `AppsSubNav` CONTAINER (not the pure `AppsSubNavView`) so the
 * `useIsClient` gate is exercised. A summary with EVERY flag true is supplied via the
 * mocked query; the assertion is that the pre-mount render still shows ONLY the
 * always-on tabs. Reverting the fix (using `data ?? EMPTY_SUMMARY` unconditionally)
 * renders all 6 tabs pre-mount and fails the first test — the exact divergence that
 * broke hydration in prod.
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
}));

vi.mock('~/providers/IsClientProvider', () => ({
  useIsClient: () => mocks.isClient,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'dev' }),
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      getNavSummary: {
        useQuery: () => ({ data: mocks.navSummary }),
      },
    },
  },
}));

const { AppsSubNav } = await import('./AppsSubNav');

function tab(name: string) {
  return page.getByRole('tab', { name });
}

const CONDITIONAL = ['Installed', 'My submissions', 'Revenue', 'Review'] as const;

beforeEach(() => {
  mocks.isClient = false;
  // Simulate the query data being present on the client (the prod condition): a mod
  // user whose summary is fully populated.
  mocks.navSummary = { ...ALL_TRUE_SUMMARY };
});

describe('AppsSubNav container — hydration-safe conditional tabs', () => {
  test('pre-mount (server + first client paint) renders ONLY the always-on tabs, even when the query already has a full summary', async () => {
    mocks.isClient = false; // server / first client paint
    renderWithProviders(<AppsSubNav />);

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
    renderWithProviders(<AppsSubNav />);

    for (const name of ['Marketplace', 'Create', ...CONDITIONAL]) {
      await expect.element(tab(name)).toBeInTheDocument();
    }
  });

  test('pre-mount with NO summary data also shows only the always-on tabs (server parity)', async () => {
    mocks.isClient = false;
    mocks.navSummary = undefined; // server: query never resolved
    renderWithProviders(<AppsSubNav />);

    await expect.element(tab('Marketplace')).toBeInTheDocument();
    await expect.element(tab('Create')).toBeInTheDocument();
    for (const name of CONDITIONAL) {
      expect(tab(name).elements()).toHaveLength(0);
    }
  });
});
