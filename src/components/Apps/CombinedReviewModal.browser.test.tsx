import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The COMBINED code + listing-media review surface (Item 4) — browser-mode render
 * test (report-only in Tekton; the blocking gate for the pairing logic is the
 * `unifiedReviewRow` unit suite). Asserts:
 *  - BOTH stacked section headers render (App code review + Listing media);
 *  - the CODE section shows the agent ReportTabs (Scopes/Security/Code review);
 *  - the MEDIA section shows the listing PREVIEW (card + detail) + the assets/
 *    content-review surface;
 *  - the two approve buttons call DISTINCT procs with DISTINCT request ids —
 *    approving the code section fires ONLY `blocks.approveRequest`; approving the
 *    media section fires ONLY `appListings.approveExternalRequest`.
 *
 * Everything network-touching (both bodies' many trpc queries/mutations) is mocked;
 * `mocks.mutate(name, vars)` records every mutation so the distinct-handler
 * assertion can prove approving one section never triggers the other's proc.
 */

const CODE_REQUEST = {
  id: 'code-req-1',
  appBlockId: 'blk_1',
  slug: 'combo-app',
  version: '1.2.0',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
  bundleSizeBytes: '2048',
  bundleSha256: 'abcdef0123456789abcdef0123456789',
  manifest: {
    name: 'Combo App',
    blockId: 'blk_1',
    version: '1.2.0',
    scopes: ['user:read'],
    targets: [{ slotId: 'model.sidebar_top', priority: 10 }],
  },
  fileSummary: { files: [{ path: 'index.js', sha256: 'x', sizeBytes: 10 }], added: ['index.js'], removed: [], changed: [] },
  manifestDiffSummary: { kind: 'first-version', fields: ['name'] },
  reviewRepoUrl: 'https://forgejo.example/repo',
  pushCommitUrl: null as string | null,
  submittedBy: { id: 7, username: 'dev-user', image: null },
};

const LISTING_ROW = {
  id: 'media-req-1',
  kind: 'onsite' as const,
  appListingId: 'apl_1',
  slug: 'combo-app',
  status: 'pending',
  submittedAt: '2026-01-02T00:00:00Z',
  changelog: null,
  appListing: {
    name: 'Combo App',
    externalUrl: null,
    category: 'utility',
    contentRating: 'PG',
  },
  submittedBy: { id: 7, username: 'dev-user', image: null },
};

const SELECTION = {
  onsiteRequestId: CODE_REQUEST.id,
  listingRequestId: LISTING_ROW.id,
  onsiteRequest: CODE_REQUEST,
  listingRow: LISTING_ROW,
};

const AGENT_REPORT = {
  status: 'complete',
  codeReview: { findings: [{ severity: 'medium', title: 'A code finding', detail: 'code detail' }] },
  securityAudit: { findings: [] },
  scopeVerdicts: { scopes: [] },
};

// Clean, fully-scanned assets so the media Approve… is enabled (not scan-gated).
const ASSETS = {
  listingId: 'apl_1',
  iconId: 1,
  coverId: 2,
  iconNsfwLevel: 1,
  coverNsfwLevel: 1,
  iconScanStatus: 'scanned',
  coverScanStatus: 'scanned',
  screenshots: [{ id: 's1', imageId: 3, order: 0, caption: null, nsfwLevel: 1, scanStatus: 'scanned' }],
  completeness: { complete: true, missing: [] },
  hasBlockedAsset: false,
  hasPendingScan: false,
};

// The mod-only listing-preview projection result: the shadow's REAL media + scalars,
// projected into the store card + detail shapes (the section renders these directly).
const LISTING_PREVIEW = {
  card: {
    id: 'apl_1',
    slug: 'combo-app',
    kind: 'onsite' as const,
    name: 'Combo App',
    tagline: 'a handy combo',
    category: 'utility',
    contentRating: 'PG',
    iconUrl: 'https://cdn.example/icon.png',
    coverUrl: 'https://cdn.example/cover.png',
    creator: { id: 7, username: 'dev-user', image: null },
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    kindData: { kind: 'onsite' as const, appBlockId: 'blk_1', hasPage: false, liveUrl: '' },
  },
  detail: {
    id: 'apl_1',
    serialId: 1,
    slug: 'combo-app',
    kind: 'onsite' as const,
    name: 'Combo App',
    tagline: 'a handy combo',
    description: 'About the combo app.',
    category: 'utility',
    contentRating: 'PG',
    iconUrl: 'https://cdn.example/icon.png',
    coverUrl: 'https://cdn.example/cover.png',
    creator: { id: 7, username: 'dev-user', image: null },
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    screenshots: [{ url: 'https://cdn.example/shot-1.png', caption: 'shot one' }],
    kindData: { kind: 'onsite' as const, appBlockId: 'blk_1', hasPage: false, liveUrl: '' },
  },
};

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  mutate: vi.fn(),
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksAgenticReview: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// Keep the code section's heavy sub-graphs light (their own behaviour is covered
// elsewhere): the review host bridge + the agent chat.
vi.mock('~/components/Apps/ReviewBlockPreviewHost', () => ({
  ReviewBlockPreviewHost: () => <div data-testid="review-host-stub" />,
}));
vi.mock('~/components/Apps/AgentReviewChat', () => ({ AgentReviewChat: () => null }));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

vi.mock('~/utils/trpc', () => {
  const mutation =
    (name: string) =>
    (opts?: { onSuccess?: () => void; onError?: (e: { message: string }) => void }) => ({
      mutate: (vars: unknown) => {
        mocks.mutate(name, vars);
        void opts?.onSuccess?.();
      },
      mutateAsync: vi.fn(),
      isPending: false,
    });
  const inert = { invalidate: mocks.invalidate };
  const utils = {
    blocks: {
      listPendingRequests: inert,
      listApprovedRequests: inert,
      listRejectedRequests: inert,
      getReviewStatus: inert,
      listActivePreviews: inert,
      getAgentReview: inert,
      getMarketplaceMeta: inert,
      getFeaturedBlocks: inert,
      listAvailable: inert,
    },
    appListings: {
      listPendingRequests: inert,
      listApprovedRequests: inert,
      listRejectedRequests: inert,
    },
  };
  return {
    trpc: {
      useUtils: () => utils,
      blocks: {
        approveRequest: { useMutation: mutation('blocks.approve') },
        rejectRequest: { useMutation: mutation('blocks.reject') },
        getReviewStatus: { useQuery: () => ({ data: null, isLoading: false, error: null }) },
        previewRequest: { useMutation: mutation('blocks.preview') },
        teardownPreview: { useMutation: mutation('blocks.teardown') },
        getPublishRequestScreenshots: {
          useQuery: () => ({ data: { items: [] }, isLoading: false, error: null }),
        },
        getPublishRequestDiff: { useQuery: () => ({ data: undefined, isLoading: false, error: null }) },
        getAgentReview: {
          useQuery: () => ({
            data: AGENT_REPORT,
            isLoading: false,
            error: null,
            failureCount: 0,
            refetch: vi.fn(),
          }),
        },
        startAgentReview: { useMutation: mutation('blocks.startAgentReview') },
        getMarketplaceMeta: {
          useQuery: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
        },
        setMarketplaceMeta: { useMutation: mutation('blocks.setMeta') },
      },
      appListings: {
        getAssets: { useQuery: () => ({ data: ASSETS, isLoading: false, error: null }) },
        approveExternalRequest: { useMutation: mutation('appListings.approve') },
        rejectExternalRequest: { useMutation: mutation('appListings.reject') },
        // The mod-only listing-preview projection — returns the shadow's REAL media
        // + scalars so the media section renders the actual card + detail preview.
        getListingPreviewForReview: {
          useQuery: () => ({ data: LISTING_PREVIEW, isLoading: false, error: null }),
        },
      },
    },
  };
});

const { CombinedReviewModal } = await import('./CombinedReviewModal');

beforeEach(() => {
  mocks.invalidate.mockClear();
  mocks.mutate.mockClear();
});

describe('CombinedReviewModal', () => {
  test('renders BOTH section headers, the code ReportTabs, and the media preview + assets', async () => {
    renderWithProviders(<CombinedReviewModal selection={SELECTION} onClose={vi.fn()} />);

    // Both stacked section headers.
    await expect.element(page.getByText('App code review')).toBeInTheDocument();
    await expect.element(page.getByText('Listing media')).toBeInTheDocument();

    // Code section: the agent ReportTabs (its tabs) render.
    await expect.element(page.getByRole('tab', { name: /Scopes/ })).toBeInTheDocument();
    await expect.element(page.getByRole('tab', { name: /Code review/ })).toBeInTheDocument();
    // Code section: the on-site bundle affordance.
    await expect.element(page.getByText('View full source')).toBeInTheDocument();

    // Media section: the listing PREVIEW (card + detail) + the content-review surface.
    await expect.element(page.getByTestId('apps-listing-preview')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-listing-preview-card')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-listing-preview-detail')).toBeInTheDocument();
    await expect.element(page.getByText('Content review checklist')).toBeInTheDocument();
    // The REAL projected data renders — the tagline + description come ONLY from the
    // proc projection (the placeholder-fallback builder yields null for both), so their
    // presence proves the preview is showing the real shadow projection, not a fallback.
    const detailScope = page.getByTestId('apps-listing-preview-detail');
    await expect.element(detailScope.getByText('a handy combo')).toBeInTheDocument();
    await expect.element(detailScope.getByText('About the combo app.')).toBeInTheDocument();
  });

  test('approving the CODE section fires ONLY blocks.approveRequest with the code request id', async () => {
    renderWithProviders(<CombinedReviewModal selection={SELECTION} onClose={vi.fn()} />);
    await page.getByRole('button', { name: 'Approve + build' }).click();

    const names = mocks.mutate.mock.calls.map((c) => c[0]);
    expect(names).toContain('blocks.approve');
    expect(names).not.toContain('appListings.approve');
    const approveCall = mocks.mutate.mock.calls.find((c) => c[0] === 'blocks.approve');
    expect(approveCall?.[1]).toMatchObject({ publishRequestId: 'code-req-1' });
  });

  test('approving the MEDIA section fires ONLY appListings.approveExternalRequest with the media request id', async () => {
    renderWithProviders(<CombinedReviewModal selection={SELECTION} onClose={vi.fn()} />);
    // Two-step: open the approve sub-form, then confirm.
    await page.getByTestId('apps-offsite-approve-open').click();
    await page.getByTestId('apps-offsite-approve-confirm').click();

    const names = mocks.mutate.mock.calls.map((c) => c[0]);
    expect(names).toContain('appListings.approve');
    expect(names).not.toContain('blocks.approve');
    const approveCall = mocks.mutate.mock.calls.find((c) => c[0] === 'appListings.approve');
    expect(approveCall?.[1]).toMatchObject({ publishRequestId: 'media-req-1' });
  });
});
