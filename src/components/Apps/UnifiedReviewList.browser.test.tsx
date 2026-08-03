import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { OffsitePendingRow } from './OffsiteReviewQueue';
import type { OffsiteReviewRequest, OnsiteReviewRequest } from './unifiedReviewRow';

/**
 * The unified moderator review LIST — browser-mode render test (report-only in
 * Tekton; the pure adapters/merge in `unifiedReviewRow.test.ts` are the blocking
 * gate). Asserts a list built from ONE on-site + ONE off-site row:
 *  - renders BOTH rows with the correct kind badge (App / External);
 *  - orders oldest-first for `direction="asc"` (pending);
 *  - clicking a row's Review invokes the CORRECT opener (on-site → openOnsite with
 *    the original request; off-site → openOffsite with the built OffsitePendingRow),
 *    NEVER the other — the core no-cross-routing invariant.
 */

const ONSITE: OnsiteReviewRequest = {
  id: 'or1',
  appBlockId: null,
  slug: 'my-onsite',
  version: '1.0.0',
  submittedAt: '2026-01-01T00:00:00Z', // older → first under asc
  bundleSizeBytes: '10',
  bundleSha256: 'sha',
  manifest: { name: 'My Onsite App' },
  fileSummary: {},
  manifestDiffSummary: {},
  reviewRepoUrl: 'https://forgejo.example/repo',
  submittedBy: { id: 7, username: 'onsite-dev', image: null },
} as OnsiteReviewRequest;

const OFFSITE: OffsiteReviewRequest = {
  id: 'fr1',
  appListingId: 'apl_1',
  slug: 'my-offsite',
  status: 'pending',
  submittedAt: '2026-02-01T00:00:00Z', // newer → second under asc
  changelog: null,
  appListing: {
    name: 'My External App',
    externalUrl: 'https://ex.com',
    category: 'utility',
    contentRating: 'g',
  },
  submittedBy: { id: 9, username: 'offsite-dev', image: null },
};

const { UnifiedReviewList } = await import('./UnifiedReviewList');

function renderList(overrides?: {
  openOnsite?: (r: OnsiteReviewRequest) => void;
  openOffsite?: (r: OffsitePendingRow) => void;
}) {
  const openOnsite = overrides?.openOnsite ?? vi.fn();
  const openOffsite = overrides?.openOffsite ?? vi.fn();
  renderWithProviders(
    <UnifiedReviewList
      onsiteItems={[ONSITE]}
      offsiteItems={[OFFSITE]}
      direction="asc"
      openOnsiteReview={openOnsite}
      openOffsiteReview={openOffsite}
      isLoading={false}
      emptyLabel="empty"
      dateLabel="Submitted"
      actionLabel="Review"
      hasMore={false}
      onLoadMore={vi.fn()}
    />
  );
  return { openOnsite, openOffsite };
}

describe('UnifiedReviewList — renders both kinds with correct badges', () => {
  test('both rows render with App / External kind badges', async () => {
    renderList();
    await expect
      .element(page.getByTestId('apps-unified-review-kind-onsite:or1'))
      .toHaveTextContent('App');
    await expect
      .element(page.getByTestId('apps-unified-review-kind-offsite:fr1'))
      .toHaveTextContent('External');
    // Both apps' names surface.
    await expect.element(page.getByText('My Onsite App')).toBeInTheDocument();
    await expect.element(page.getByText('My External App')).toBeInTheDocument();
  });

  test('oldest-first order under direction="asc" (on-site row precedes off-site)', async () => {
    renderList();
    // Wait for the async render to commit before the synchronous `.elements()`
    // read — reading immediately after renderList() races the mount and returns 0.
    await expect
      .element(page.getByTestId('apps-unified-review-row-onsite:or1'))
      .toBeInTheDocument();
    const rows = page.getByTestId(/^apps-unified-review-row-/).elements();
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-testid')).toBe('apps-unified-review-row-onsite:or1');
    expect(rows[1].getAttribute('data-testid')).toBe('apps-unified-review-row-offsite:fr1');
  });
});

describe('UnifiedReviewList — Review routes to the correct modal opener (no cross)', () => {
  test('clicking the on-site row Review invokes openOnsite with the original request only', async () => {
    const { openOnsite, openOffsite } = renderList();
    await page.getByTestId('apps-unified-review-action-onsite:or1').click();
    expect(openOnsite).toHaveBeenCalledTimes(1);
    expect(openOnsite).toHaveBeenCalledWith(ONSITE);
    expect(openOffsite).not.toHaveBeenCalled();
  });

  test('clicking the off-site row Review invokes openOffsite with the built row only', async () => {
    const { openOnsite, openOffsite } = renderList();
    await page.getByTestId('apps-unified-review-action-offsite:fr1').click();
    expect(openOffsite).toHaveBeenCalledTimes(1);
    const passed = (openOffsite as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(passed.id).toBe('fr1');
    expect(passed.appListingId).toBe('apl_1');
    expect(passed.slug).toBe('my-offsite');
    expect(openOnsite).not.toHaveBeenCalled();
  });
});
