import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * P2c AppListingDetailBody component tests (REPORT-ONLY — the browser project is
 * non-blocking; the blocking gate is appListingDetailView.test.ts). These pin the
 * owner "Edit" deep-link gating (Item 2) + the long-username tooltip fallback
 * (Item 1) on the detail surface. The trpc-consuming children (reviews / report /
 * comments) are mocked to null so this stays network-free and header-focused.
 */

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: number; username: string },
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser,
}));

// Header-focused: stub the trpc-backed children (reviews/report/comments) so the
// test needs no tRPC wiring.
vi.mock('~/components/Apps/ReviewListingButton', () => ({ ReviewListingButton: () => null }));
vi.mock('~/components/Apps/ReportListingButton', () => ({ ReportListingButton: () => null }));
vi.mock('~/components/Apps/AppListingReviews', () => ({ AppListingReviews: () => null }));
vi.mock('~/components/Apps/AppListingComments', () => ({ AppListingComments: () => null }));

// Import AFTER the mocks are declared (vi.mock is hoisted, imports are not).
const { AppListingDetailBody } = await import('./AppListingDetailBody');

beforeEach(() => {
  mocks.currentUser = null;
});

function base(over: Partial<ListingDetail>): ListingDetail {
  return {
    id: 'l1',
    serialId: 1,
    slug: 'my-app',
    kind: 'onsite',
    name: 'My App',
    tagline: 'A handy app',
    description: null,
    category: 'utility',
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: { id: 5, username: 'alice', image: null },
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    screenshots: [],
    kindData: { kind: 'onsite', appBlockId: 'blk-1', hasPage: true, liveUrl: 'https://my-app.civit.ai' },
    ...over,
  };
}

describe('AppListingDetailBody', () => {
  test('kind + category badges are NOT rendered on the detail header (round-2 truncation fix)', async () => {
    // "App" was formerly the on-site kind badge's exact-match text; "utility" is
    // base()'s category → labeled "Utility". Neither should render now — the
    // kind signal instead lives in the primary-action CTA + the off-site
    // disclosure Alert.
    renderWithProviders(<AppListingDetailBody detail={base({})} />);
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    await expect.element(page.getByText('App', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText('Utility', { exact: true })).not.toBeInTheDocument();
  });

  test('contentRating badge STILL renders (not removed — it is not a kind/category badge)', async () => {
    renderWithProviders(<AppListingDetailBody detail={base({ contentRating: 'PG' })} />);
    await expect.element(page.getByText('PG', { exact: true })).toBeInTheDocument();
  });

  test('owner sees the Edit deep-link → on-site manifest editor', async () => {
    mocks.currentUser = { id: 5, username: 'alice' }; // matches base().creator.id
    renderWithProviders(<AppListingDetailBody detail={base({})} />);
    const edit = page.getByTestId('apps-listing-owner-edit');
    await expect.element(edit).toBeInTheDocument();
    await expect.element(edit).toHaveAttribute('href', '/apps/blk-1/edit-manifest');
  });

  test('owner of an off-site listing → Edit routes to the submit editor by listing id', async () => {
    mocks.currentUser = { id: 5, username: 'alice' };
    renderWithProviders(
      <AppListingDetailBody
        detail={base({
          kind: 'offsite',
          kindData: {
            kind: 'offsite',
            subKind: 'external-link',
            externalUrl: 'https://ext.app',
            connectClientId: null,
          },
        })}
      />
    );
    await expect
      .element(page.getByTestId('apps-listing-owner-edit'))
      .toHaveAttribute('href', '/apps/submit?edit=l1');
  });

  test('non-owner does NOT see the Edit deep-link', async () => {
    mocks.currentUser = { id: 999, username: 'bob' };
    renderWithProviders(<AppListingDetailBody detail={base({})} />);
    await expect.element(page.getByTestId('apps-listing-owner-edit')).not.toBeInTheDocument();
  });

  test('signed-out viewer does NOT see the Edit deep-link', async () => {
    mocks.currentUser = null;
    renderWithProviders(<AppListingDetailBody detail={base({})} />);
    await expect.element(page.getByTestId('apps-listing-owner-edit')).not.toBeInTheDocument();
  });

  test('a long username reveals the full value in a tooltip on hover (clip fallback)', async () => {
    const longName = 'a-really-long-creator-username-that-will-definitely-overflow-the-header-column';
    renderWithProviders(
      <AppListingDetailBody detail={base({ creator: { id: 5, username: longName, image: null } })} />
    );
    const label = page.getByText(`by ${longName}`);
    await expect.element(label).toBeInTheDocument();
    await label.hover();
    await expect.element(page.getByText(longName, { exact: true })).toBeInTheDocument();
  });
});
