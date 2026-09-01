import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as TrpcMod from '~/utils/trpc';

/**
 * F4 — the App Blocks host chrome's two REVIEW ENTRY POINTS: an item in the ⋮
 * overflow menu and an action in the app-name popover, both opening the existing
 * `ReviewListingModal`.
 *
 * 🔴 EVERY TEST MOUNTS `AppBlockChrome`, NOT THE ENTRY-POINT COMPONENTS. Three of
 * the five claims this file makes are about the SEAM rather than about a component:
 * that the chrome threads the slug down, that the chrome owns the modal state both
 * triggers write to, and that opening the modal closes the surface the trigger lives
 * in. A suite that rendered `ChromeReviewMenuItem` on its own would verify a correct
 * component behind a host wiring it to nothing — the failure mode RULES calls the
 * isolation seam, and the exact one F2's own suite calls out.
 *
 * 🔴 THE tRPC MOCK IS BACKED BY REAL REACT QUERY, WHICH IS WHAT MAKES THE
 * "ONE REQUEST" CLAIM MEAN ANYTHING. A hand-rolled `useQuery: () => ({data})` stub
 * counts HOOK CALLS, and hook calls are not requests — a stub like that reports "2"
 * for correctly deduped code and "1" for code that fires twice through one shared
 * component, i.e. it cannot see the defect either way. Here each procedure is a thin
 * wrapper over the real `useQuery` with a counting `queryFn`, so the counter is the
 * number of times the cache actually went and fetched, under the real key-hashing
 * and the real staleness rules.
 *
 * 🔴 …AND THE CLIENT IS CONFIGURED LIKE PRODUCTION'S, NOT LIKE THE SHARED HARNESS'S.
 * `renderWithProviders` builds a `QueryClient` with `gcTime: 0` and React Query's
 * default `staleTime: 0`, whereas `src/utils/trpc.ts` ships `staleTime: Infinity`.
 * Under the harness defaults an unmount/remount refetches, so the dedupe assertion
 * would measure the harness rather than the app and would fail against correct code.
 * The local wrapper below mirrors the app's `queryClientConfig`; the divergence is
 * pinned by `chromeListingQueryIsSingleSourced.test.ts`, which reads the real number
 * out of `trpc.ts`.
 */

const mocks = vi.hoisted(() => ({
  // `appListings` OR `appBlocks` OR `appListingsPublicExternal` → store access.
  features: { appListings: true } as Record<string, boolean>,
  user: { id: 7, username: 'viewer', isModerator: false } as unknown,
  detail: null as unknown,
  myReview: null as unknown,
  /** How many times the cache actually FETCHED the listing. Not hook calls. */
  detailFetches: 0,
  myReviewFetches: 0,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));

// Both flag hooks, to the same flags: `useCanReviewListing` and the store-access gate
// read `useOptionalFeatureFlags` (fail-closed outside a provider), while the chrome's
// host half reads `useFeatureFlags`. Overriding only one leaves the other resolving
// the real null-outside-provider value, which silently hides the whole affordance and
// makes every test below fail for a reason unrelated to what it asserts.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => mocks.features,
  useOptionalFeatureFlags: () => mocks.features,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { useQuery } = await import('@tanstack/react-query');
  const invalidate = vi.fn().mockResolvedValue(undefined);
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: {
      appListings: {
        getAppDetail: {
          useQuery: (input: unknown, opts?: Record<string, unknown>) =>
            useQuery({
              // The same shape tRPC builds, so React Query's own hashing decides
              // whether two call sites collide — which is the property under test.
              queryKey: [['appListings', 'getAppDetail'], { input, type: 'query' }],
              queryFn: async () => {
                mocks.detailFetches += 1;
                return mocks.detail;
              },
              ...opts,
            }),
        },
        getMyReview: {
          useQuery: (input: unknown, opts?: Record<string, unknown>) =>
            useQuery({
              queryKey: [['appListings', 'getMyReview'], { input, type: 'query' }],
              queryFn: async () => {
                mocks.myReviewFetches += 1;
                return mocks.myReview;
              },
              ...opts,
            }),
        },
        // Only reached once the modal is mounted; the modal's own submit path has its
        // own suite (`ReviewListingButton.browser.test.tsx`).
        upsertReview: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      },
      useUtils: () => ({
        appListings: {
          getMyReview: { invalidate },
          listReviews: { invalidate },
          getAppDetail: { invalidate },
        },
      }),
    },
  };
});

// eslint-disable-next-line import/first
import { AppBlockChrome } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import { useChromeListingDetail } from '~/components/AppBlocks/useChromeListingDetail';

const APP_NAME = 'Budgeted Generator';
const SLUG = 'budgeted-generator';
const OWNER_ID = 4242;

/** A `ListingDetail`-shaped fixture — only the fields these paths read. */
function detailFixture(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_01HZ',
    slug: SLUG,
    name: APP_NAME,
    kind: 'onsite',
    creator: { id: OWNER_ID, username: 'publisher', image: null },
    recommend: { recommendedCount: 9, notRecommendedCount: 1, recommendPct: 0.9 },
    reviewCount: 10,
    ...over,
  };
}

/**
 * Providers mirroring the APP's query configuration (`queryClientConfig` in
 * `src/utils/trpc.ts`), not the shared harness's. See the file header.
 */
function ProdishProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity },
          mutations: { retry: false },
        },
      })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider>{children}</MantineProvider>
    </QueryClientProvider>
  );
}

/**
 * A second observer of the SAME listing query, rendering a marker once the row has
 * landed.
 *
 * 🔴 IT EXISTS BECAUSE "THE ITEM IS ABSENT" IS UNFALSIFIABLE WITHOUT IT — MEASURED,
 * NOT ANTICIPATED. `expect.element(x).not.toBeInTheDocument()` POLLS UNTIL IT PASSES,
 * and at the instant the dropdown opens the item is legitimately absent for everyone,
 * because its data has not arrived. So the assertion passed at t0 whether the gate
 * worked or not: three mutants that DELETED a gate term outright (the owner term, the
 * `listingKind` term, and the signed-out term inverted to `true`) all SURVIVED a fully
 * green run of this file. Adding a fixed `setTimeout` would swap the hole for a
 * timing dependency; this is a real happens-before instead — React Query notifies
 * every observer of one key inside a single `notifyManager` batch, so by the time
 * this marker is in the document the entry point has had its data in the SAME commit.
 * All three mutants die now.
 *
 * It shares the key, so it adds an observer and NOT a request; the "no store access →
 * zero requests" test therefore does not mount it.
 */
function ListingProbe({ slug }: { slug: string }) {
  const { detail } = useChromeListingDetail(slug);
  return detail ? <span data-testid="listing-probe-resolved" /> : null;
}

function renderChrome(props: Record<string, unknown> = {}) {
  return render(
    <AppBlockChrome
      blockInstanceId="inst-f4"
      appName={APP_NAME}
      slug={SLUG}
      slotId="app.page"
      {...props}
    />,
    { wrapper: ProdishProviders }
  );
}

/** The chrome plus the probe — for any test whose claim is that the item is ABSENT. */
function renderChromeWithProbe(props: Record<string, unknown> = {}) {
  const slug = (props.slug as string | undefined) ?? SLUG;
  return render(
    <>
      <AppBlockChrome
        blockInstanceId="inst-f4"
        appName={APP_NAME}
        slug={SLUG}
        slotId="app.page"
        {...props}
      />
      <ListingProbe slug={slug} />
    </>,
    { wrapper: ProdishProviders }
  );
}

/** The listing row has landed AND been rendered — see {@link ListingProbe}. */
async function awaitListingResolved() {
  await expect.element(page.getByTestId('listing-probe-resolved')).toBeInTheDocument();
}

/** Open the ⋮ overflow menu and wait for a permanent item, so the dropdown mounted. */
/**
 * Open the ⋮ overflow and wait for its contents.
 *
 * 🔴 WAITS ON THE SURFACE'S CONTENT BOX, NOT ON A `menuitem` ROLE — because F3 gave
 * this control two renderings and only one of them has that role. Above the `sm`
 * breakpoint the ⋮ is a `Menu` whose items are `menuitem`s; below it, it is a bottom
 * sheet whose rows are buttons. `app-block-menu-dropdown` is the testid
 * `ChromeSurface` puts on whichever content box it rendered, so this helper reads the
 * same thing at both widths — which is what lets the 375px full-screen-modal test
 * below exercise F4 THROUGH the sheet rather than needing a parallel helper.
 */
async function openOverflow() {
  await page.getByTestId('app-block-menu-trigger').click();
  await expect.element(page.getByTestId('app-block-menu-dropdown')).toBeInTheDocument();
}

/** Open the app-name crumb popover and wait for its body. */
async function openNamePopover() {
  await page.getByTestId('app-block-breadcrumb-name').click();
  await expect.element(page.getByTestId('app-block-name-popover')).toBeInTheDocument();
}

const reviewItem = () => page.getByTestId('app-block-review-menu-item');
const popoverAction = () => page.getByTestId('app-block-name-popover-review');
const modalHeading = () => page.getByText('Would you recommend this app to others?');

beforeEach(async () => {
  mocks.features = { appListings: true };
  mocks.user = { id: 7, username: 'viewer', isModerator: false };
  mocks.detail = detailFixture();
  mocks.myReview = null;
  mocks.detailFetches = 0;
  mocks.myReviewFetches = 0;
  // Desktop unless a test says otherwise — the modal's `fullScreen` is a viewport
  // media query, so leaving the viewport wherever the previous test left it would
  // make that pair of tests order-dependent.
  await page.viewport(1280, 900);
});

describe('the ⋮ overflow menu offers a review entry point', () => {
  test('an eligible viewer gets "Rate this app", alongside the existing items', async () => {
    renderChrome({ appBlockId: 'ab-1' });
    await openOverflow();

    await expect.element(reviewItem()).toBeInTheDocument();
    expect((reviewItem().element().textContent ?? '').trim()).toBe('Rate this app');

    // It reads as one of the chrome's own app actions, not as a route link: the
    // existing permanent items are still there and it sits among them.
    await expect.element(page.getByRole('menuitem', { name: 'Manage apps' })).toBeInTheDocument();
    await expect
      .element(page.getByRole('menuitem', { name: 'Permissions & activity' }))
      .toBeInTheDocument();
    // An ACTION, not a destination — no `href`, which is what keeps it out of the
    // ONE ROUTE, ONE ICON extractor in `chromeNavAlignsWithSubNav.test.ts`.
    expect(reviewItem().element().getAttribute('href')).toBeNull();
  });

  test('the label switches to "Edit your review" when the viewer already has one', async () => {
    mocks.myReview = { id: 'rev_1', recommended: true, details: 'good' };
    renderChrome();
    await openOverflow();

    await expect.element(reviewItem()).toBeInTheDocument();
    // Polls: the label depends on a real async query resolving, so a synchronous
    // read here would sample the pre-fetch render and pass for the wrong reason.
    await expect.element(reviewItem()).toHaveTextContent('Edit your review');
    expect(mocks.myReviewFetches).toBeGreaterThan(0);
  });
});

describe('the item appears only when the SERVER would accept the review', () => {
  test('it is ABSENT for the listing owner (a self-review is 403d)', async () => {
    mocks.user = { id: OWNER_ID, username: 'publisher', isModerator: false };
    renderChromeWithProbe();
    await openOverflow();

    // The listing DID resolve and HAS rendered — so this is the gate refusing, not
    // the data merely not having arrived yet. Without this the absence assertion
    // passes at t0 for everyone (see `ListingProbe`).
    await awaitListingResolved();
    expect(mocks.detailFetches).toBe(1);
    expect(reviewItem().elements()).toHaveLength(0);
  });

  test('it is ABSENT for a signed-out viewer (the write proc is protected)', async () => {
    mocks.user = null;
    renderChromeWithProbe();
    await openOverflow();
    await awaitListingResolved();
    expect(reviewItem().elements()).toHaveLength(0);
  });

  test('it is ABSENT when the viewer’s store scope does not admit the listing KIND', async () => {
    // The external-only cohort: `public-external` scope, reaching an ONSITE listing.
    // This is the exact pair the server NOT_FOUNDs, and the mirror image of the
    // defect `useCanReviewListing`'s kind term was added to close.
    mocks.features = { appListingsPublicExternal: true };
    renderChromeWithProbe();
    await openOverflow();

    await awaitListingResolved();
    expect(reviewItem().elements()).toHaveLength(0);
  });

  test('the SAME viewer IS offered it on an OFFSITE listing — the kind term, not a blanket refusal', async () => {
    // Positive control on the test above: without this, "absent" there would be
    // indistinguishable from "this cohort never sees the item at all", and a gate
    // that hid the affordance from everyone would pass both.
    mocks.features = { appListingsPublicExternal: true };
    mocks.detail = detailFixture({ kind: 'offsite' });
    renderChrome();
    await openOverflow();
    await expect.element(reviewItem()).toBeInTheDocument();
  });

  test('a viewer with NO store access gets no item AND no listing request at all', async () => {
    // Every term of `hasAppsStoreAccess` off — the cohort for which `getAppDetail`
    // resolves a `none` scope and throws NOT_FOUND. The affordance is withheld
    // before the query is even instantiated, so this asserts the FETCH COUNT and not
    // just the absent DOM.
    mocks.features = {};
    renderChrome();
    await openOverflow();

    await expect.element(reviewItem()).not.toBeInTheDocument();
    expect(mocks.detailFetches).toBe(0);
    expect(mocks.myReviewFetches).toBe(0);
  });

  test('with no slug threaded there is no entry point (nothing to review)', async () => {
    renderChrome({ slug: undefined, slotId: 'model.sidebar_top' });
    await openOverflow();
    await expect.element(reviewItem()).not.toBeInTheDocument();
    expect(mocks.detailFetches).toBe(0);
  });
});

describe('each entry point closes ITS OWN opener when the modal opens', () => {
  test('the ⋮ menu closes, and the modal opens', async () => {
    renderChrome({ appBlockId: 'ab-1' });
    await openOverflow();
    await expect.element(reviewItem()).toBeInTheDocument();

    await reviewItem().click();

    // 🔴 THE DROPDOWN IS GONE, not merely visually behind the modal. A dropdown left
    // mounted under a focus-trapping modal keeps `aria-expanded="true"` on its
    // trigger and re-appears when the modal closes — the visible half of the defect
    // F0 fixed, one surface further along.
    await expect.element(modalHeading()).toBeInTheDocument();
    await expect
      .element(page.getByRole('menuitem', { name: 'Manage apps' }))
      .not.toBeInTheDocument();
    expect(page.getByTestId('app-block-menu-trigger').element().getAttribute('aria-expanded')).toBe(
      'false'
    );
  });

  test('the name popover closes, and the modal opens', async () => {
    renderChrome();
    await openNamePopover();
    await expect.element(popoverAction()).toBeInTheDocument();

    await popoverAction().click();

    await expect.element(modalHeading()).toBeInTheDocument();
    await expect.element(page.getByTestId('app-block-name-popover')).not.toBeInTheDocument();
    expect(
      page.getByTestId('app-block-breadcrumb-name').element().getAttribute('aria-expanded')
    ).toBe('false');
  });

  test('the popover action is withheld from a viewer who may not review', async () => {
    mocks.user = { id: OWNER_ID, username: 'publisher', isModerator: false };
    renderChrome();
    await openNamePopover();
    // The store link IS there — so the popover resolved its listing and this is the
    // review gate refusing, not an empty card.
    await expect.element(page.getByTestId('app-block-name-popover-store-link')).toBeInTheDocument();
    await expect.element(popoverAction()).not.toBeInTheDocument();
  });
});

describe('the two entry points share ONE listing request', () => {
  test('opening the ⋮ menu and then the name popover fetches the listing once', async () => {
    renderChrome();

    await openOverflow();
    await expect.element(reviewItem()).toBeInTheDocument();
    expect(mocks.detailFetches, 'the ⋮ menu should have fetched the listing exactly once').toBe(1);

    // Close the menu (Escape) and open the OTHER surface. The ⋮ dropdown unmounts,
    // so this is a genuine second mount of the same query — the case in which a
    // differently-shaped input would show up as a second fetch.
    await page.getByTestId('app-block-menu-trigger').click();
    await expect
      .element(page.getByRole('menuitem', { name: 'Manage apps' }))
      .not.toBeInTheDocument();

    await openNamePopover();
    await expect.element(popoverAction()).toBeInTheDocument();
    // The popover renders the rollup from the SAME row — proof it got the data, so a
    // "1" below cannot mean "the second surface never asked".
    await expect
      .element(page.getByTestId('app-block-name-popover-recommend'))
      .toHaveTextContent('90% recommend (10)');

    expect(
      mocks.detailFetches,
      'both chrome surfaces must resolve to ONE listing query key — a second fetch means the ' +
        'two call sites are keying it differently'
    ).toBe(1);
  });

  test('POSITIVE CONTROL — the counter does move when the key genuinely differs', async () => {
    // A dedupe assertion whose counter can only ever read 1 measures nothing. Two
    // chromes on DIFFERENT slugs are two keys and must fetch twice; if this reads 1,
    // the counter is wired to nothing and the test above is vacuous.
    render(
      <>
        <AppBlockChrome blockInstanceId="a" appName="A" slug="app-a" slotId="app.page" />
        <AppBlockChrome blockInstanceId="b" appName="B" slug="app-b" slotId="app.page" />
      </>,
      { wrapper: ProdishProviders }
    );

    const triggers = page.getByTestId('app-block-menu-trigger');
    await triggers.nth(0).click();
    await expect.element(page.getByRole('menuitem', { name: 'Manage apps' })).toBeInTheDocument();
    await vi.waitFor(() => expect(mocks.detailFetches).toBe(1));

    await triggers.nth(0).click();
    await triggers.nth(1).click();
    await vi.waitFor(() => expect(mocks.detailFetches).toBe(2));
  });
});

describe('the review modal is full-screen on a phone', () => {
  // 🔴 A REAL VIEWPORT CHANGE, NOT A MOCKED HOOK. The claim is that the modal sizes
  // itself against the VIEWPORT rather than against the page container the chrome
  // sits in (see `ReviewListingModal`'s header), and only driving the actual viewport
  // can tell those two apart — a stubbed `useIsMobile` would pass either way.
  async function openModalAt(width: number, height: number) {
    await page.viewport(width, height);
    renderChrome();
    await openOverflow();
    await expect.element(reviewItem()).toBeInTheDocument();
    await reviewItem().click();
    await expect.element(modalHeading()).toBeInTheDocument();
    const content = document.querySelector('.mantine-Modal-content') as HTMLElement | null;
    expect(content, 'the modal content element was not found').not.toBeNull();
    return content as HTMLElement;
  }

  // 🔴 THE ASSERTION IS ON WHAT MANTINE *EMITS*, NOT ON A MEASURED WIDTH. This
  // harness deliberately loads no Mantine stylesheet (see `test/component-setup.tsx`),
  // so `size="md"`'s max-width never applies and a rendered-width comparison reads
  // 1280px at BOTH viewports — measured: the first draft of the desktop control
  // failed with `expected 1280 to be less than 1280` against correct code. What the
  // component itself produces is `data-full-screen` plus an INLINE `max-height`
  // (`100dvh` vs `calc(100dvh - …)`, `Modal/ModalContent.mjs`), and those are real
  // outputs of the prop rather than a word in the source.
  test('at a 375px phone viewport the modal renders full-screen', async () => {
    const content = await openModalAt(375, 720);
    expect(content.getAttribute('data-full-screen')).toBe('true');
  });

  test('CONTROL — at a 1280px desktop viewport it does NOT', async () => {
    // Without this arm, the test above cannot tell "full-screen on a phone" from
    // "full-screen always", and a hardcoded `fullScreen` would pass it. The pair is
    // also what makes this a test of the VIEWPORT axis: the only thing that differs
    // between the two runs is `page.viewport`.
    const content = await openModalAt(1280, 900);
    expect(content.getAttribute('data-full-screen')).toBeNull();
  });
});
