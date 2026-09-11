import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * App-listing detail — the PRE-LAUNCH PERMISSION DISCLOSURE.
 *
 * The store detail page must tell a viewer what an on-site app is permitted to do
 * BEFORE they open it. The equivalent disclosure already existed on the retired
 * `/apps/<appBlockId>` route (still served by `blocks.getAppDetail`); it did not
 * travel with the detail page when it moved to `/apps/store-preview/<slug>`, which
 * is served by `appListings.getAppDetail` → this component.
 *
 * 🔴 READ THIS BEFORE TREATING ANY RESULT HERE AS A GATE: IT IS NOT ONE. This file
 * is in the Vitest browser-mode `component` project, which CI runs only as the
 * preview pipeline's `preview / component-tests` — report-only, non-blocking, and
 * not reported at all when the preview build fails. The GATING half of this change
 * lives in the blocking node project, in
 * `src/server/services/blocks/__tests__/app-listing.service.test.ts`, which pins
 * the thing that actually matters for safety: that the disclosure is fed by the
 * moderator-granted `approvedScopes` column and NEVER by the app's self-declared
 * `manifest.scopes`. That file cannot see a single DOM node; this one cannot block
 * a merge. Neither substitutes for the other, and this file exists for the half the
 * projection tests structurally cannot make — that the component actually RENDERS
 * what the DTO carries, and renders nothing when there is nothing to disclose.
 *
 * 🔴 RED/GREEN HONESTY — MEASURED, not asserted. Reverting ONLY the component to
 * `origin/main` and re-running this file gives `2 failed | 2 passed (4)`:
 *
 *   - the two POSITIVE tests fail with a real assertion (`expected null not to be
 *     null` — the section is absent), so they are genuine coverage;
 *   - the two ABSENCE tests ("no section when there are no scopes", "none for an
 *     off-site listing") PASS AT BASE, VACUOUSLY. Of course they do: they assert
 *     the section is not there, and at base it is never there for anyone.
 *
 * 🔴 So do not read "4 passed" as four guards. Two of these are regression guards
 * against an empty-box or wrong-kind regression LATER; at base they prove nothing,
 * and counting them as red-at-base evidence would be false. The regression-shaped
 * claim for the feature itself belongs to the node suite, where the pre-change
 * source was watched to fail 5 assertions, each for its own reason.
 *
 * 🔴 NO CSS IS LOADED, so nothing here measures a visual property. Every assertion
 * is structural: a `data-testid`, an accessible name, the presence or absence of a
 * node. "Is the badge orange" is not a claim this file can make — the sensitive
 * flagging is asserted via `SensitiveScopeBadge`'s own accessible text.
 *
 * 🔴 FIXTURE SCOPES ARE PAIRWISE DISTINCT AND SPAN BOTH SENSITIVITY CLASSES, on
 * purpose. A fixture of one scope, or of two scopes that are both sensitive, could
 * not tell "renders every scope" from "renders the first" nor "flags the sensitive
 * one" from "flags all of them".
 */

const WIDE: [number, number] = [1440, 900];

// Anonymous viewer — the `⋮` menu and its modals never mount; none of them are
// what this file is about, and each is a portal beside the content under test.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// 🔴 `importOriginal` SPREAD, not a wholesale replacement (local-rules/
// no-wholesale-module-mock): a hand-written factory silently breaks every importer
// the day the real module grows an export it omits — and in this project that
// surfaces as `Tests no tests`, i.e. as nothing to see rather than as a failure.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => {
  const flags = { appBlocks: true, appListings: true, appBlocksPages: false };
  return {
    ...(await importOriginal<typeof FeatureFlagsMod>()),
    useFeatureFlags: () => flags,
    useOptionalFeatureFlags: () => flags,
  };
});
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      listAvailable: { useQuery: () => ({ data: { items: [] }, isLoading: false }) },
      getMyReview: { useQuery: () => ({ data: null, isLoading: false }) },
      upsertReview: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      reportListing: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    user: {
      getCreator: { useQuery: () => ({ data: null }) },
      getById: { useQuery: () => ({ data: undefined, isInitialLoading: false }) },
    },
    useUtils: () => ({
      appListings: {
        getMyReview: { invalidate: async () => undefined },
        listReviews: { invalidate: async () => undefined },
        getAppDetail: { invalidate: async () => undefined },
      },
    }),
  },
}));
vi.mock('~/components/Apps/AppListingReviews', () => ({
  AppListingReviews: () => <div data-testid="mock-reviews" />,
}));
vi.mock('~/components/Apps/AppListingComments', () => ({
  AppListingComments: () => <div data-testid="mock-comments" />,
}));

// Import AFTER the mocks are declared (vi.mock is hoisted, imports are not).
const { AppListingDetailBody } = await import('./AppListingDetailBody');

beforeEach(async () => {
  await page.viewport(...WIDE);
});

/** One sensitive scope and one that is not, so the flagging is discriminable. */
const SENSITIVE_SCOPE = 'ai:write:budgeted';
const PLAIN_SCOPE = 'models:read:self';

function base(over: Partial<ListingDetail>): ListingDetail {
  return {
    id: 'l1',
    serialId: 1,
    slug: 'my-app',
    kind: 'onsite',
    collaborators: [],
    name: 'My App',
    tagline: 'A handy app',
    description: null,
    category: 'utility',
    contentRating: null,
    isBeta: false,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    installCount: 4213,
    sourceRepoUrl: null,
    betaMessage: null,
    updatedAt: '2026-03-04T05:06:07.000Z',
    screenshots: [],
    scopes: [],
    kindData: {
      kind: 'onsite',
      appBlockId: 'blk-1',
      hasPage: true,
      liveUrl: 'https://my-app.civit.ai',
    },
    ...over,
  };
}

async function renderBody(detail: ListingDetail) {
  const { container } = await renderWithProviders(<AppListingDetailBody detail={detail} />);
  const within = page.elementLocator(container);
  await expect.element(within.getByText('My App')).toBeInTheDocument();
  return { container, within };
}

describe('AppListingDetailBody — pre-launch permission disclosure', () => {
  test('renders every declared scope before the viewer opens the app', async () => {
    const { within } = await renderBody(base({ scopes: [PLAIN_SCOPE, SENSITIVE_SCOPE] }));

    await expect.element(within.getByTestId('apps-listing-permissions')).toBeInTheDocument();
    // Both, not just the first — the fixture's two scopes are distinct strings so
    // "rendered only one" is a different DOM than "rendered both".
    await expect.element(within.getByText(PLAIN_SCOPE)).toBeInTheDocument();
    await expect.element(within.getByText(SENSITIVE_SCOPE)).toBeInTheDocument();
  });

  test('the section is ABSENT — not empty — when the app declares no scopes', async () => {
    const { container } = await renderBody(base({ scopes: [] }));

    // 🔴 Absence, not an empty container. On a store listing "no permissions" is
    // better said by the absence of a permissions section than by a reassuring
    // sentence nobody reads, and an empty box is exactly what a `length > 0` guard
    // regression would produce.
    expect(container.querySelector('[data-testid="apps-listing-permissions"]')).toBeNull();
  });

  test('an off-site listing (no backing block) shows no permission section', async () => {
    const { container } = await renderBody(
      base({
        kind: 'offsite',
        scopes: [],
        kindData: { kind: 'offsite', externalUrl: 'https://example.com', connectClientId: null },
      })
    );

    expect(container.querySelector('[data-testid="apps-listing-permissions"]')).toBeNull();
  });

  test('a sensitive scope is distinguished from a plain one', async () => {
    const { within, container } = await renderBody(
      base({ scopes: [PLAIN_SCOPE, SENSITIVE_SCOPE] })
    );

    const section = container.querySelector('[data-testid="apps-listing-permissions"]');
    expect(section).not.toBeNull();
    // `SensitiveScopeBadge` marks the sensitive one, via its own `data-testid`
    // (verified against the component — not a selector invented here). Exactly ONE
    // badge for a fixture carrying one sensitive and one plain scope: a component
    // that flagged everything, or nothing, fails here rather than passing on a
    // coincidence. That is the whole reason the fixture spans both classes.
    const sensitiveMarks = section!.querySelectorAll('[data-testid="sensitive-scope-badge"]');
    expect(sensitiveMarks.length).toBe(1);
    await expect.element(within.getByTestId('apps-listing-permissions')).toBeInTheDocument();
  });
});
