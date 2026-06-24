import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { AvailableBlock, PublicAppDetail } from '~/server/schema/blocks/subscription.schema';

/**
 * App Blocks DETAILS modal — component tests.
 *
 * Verifies the modal consolidates the secondary app info that the 2026-06 UX
 * pass moved OFF the card face:
 *   - Header: title, author, description.
 *   - Screenshots gallery (rendered when present; gracefully absent otherwise).
 *   - Scopes (the permission disclosure, moved off the card).
 *   - A "recent reviews" section — REUSES <AppBlockReviews> (stubbed here; its
 *     own internals are covered by AppBlockReviews.browser.test.tsx).
 *
 * Network-free: the `getAppDetail` / `listMySubscriptions` tRPC queries are
 * mocked, and <AppBlockReviews> (which pulls in the review queries + avatar +
 * date machinery) is stubbed to a probe so this stays a unit of the MODAL.
 */

const mocks = vi.hoisted(() => ({
  // The detail payload getAppDetail returns (null = still loading / absent).
  detail: null as PublicAppDetail | null,
  reviewsProps: vi.fn(),
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      getAppDetail: {
        useQuery: () => ({ data: mocks.detail, isLoading: mocks.detail === null }),
      },
      listMySubscriptions: {
        useQuery: () => ({ data: [] }),
      },
    },
  },
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 42, username: 'viewer' }),
}));

// Reuse-not-rebuild: the modal must render the existing reviews component. Stub
// it to a probe that records the props it was handed (appBlockId + aggregate).
vi.mock('~/components/Apps/AppBlockReviews', () => ({
  AppBlockReviews: (props: { appBlockId: string; avgRating: number | null; reviewCount: number }) => {
    mocks.reviewsProps(props);
    return <div data-testid="reviews-section">reviews for {props.appBlockId}</div>;
  },
}));

// Import AFTER the mocks are declared (vi.mock is hoisted, imports are not).
const { AppDetailsModal } = await import('./AppDetailsModal');

function makeBlock(overrides: Partial<AvailableBlock> = {}): AvailableBlock {
  return {
    id: 'app-1',
    blockId: 'my-block',
    appId: 'app-1',
    appName: 'My App',
    manifest: {
      name: 'My App',
      description: 'Does a thing.',
      targets: [{ slotId: 'model.sidebar_top' }],
    },
    installCount: 3,
    category: null,
    scopesSummary: [],
    avgRating: null,
    reviewCount: 0,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<PublicAppDetail> = {}): PublicAppDetail {
  return {
    id: 'app-1',
    blockId: 'my-block',
    appId: 'app-1',
    appName: 'My App',
    manifest: {
      name: 'My App',
      description: 'Does a thing.',
      targets: [{ slotId: 'model.sidebar_top' }],
    },
    scopes: [],
    contentRating: null,
    version: '1.0.0',
    installCount: 3,
    avgRating: null,
    reviewCount: 0,
    liveUrl: 'https://my-block.example.com',
    screenshots: [],
    ...overrides,
  };
}

const onClose = vi.fn();

beforeEach(() => {
  mocks.detail = null;
  mocks.reviewsProps.mockClear();
  onClose.mockClear();
});

describe('AppDetailsModal', () => {
  test('closed → renders nothing visible', async () => {
    renderWithProviders(<AppDetailsModal opened={false} onClose={onClose} block={makeBlock()} />);
    // Mantine Modal renders no content when closed.
    expect(page.getByText('reviews for', { exact: false }).query()).toBeNull();
    expect(page.getByText('Does a thing.', { exact: false }).query()).toBeNull();
  });

  test('open → header renders title + author + description (from the listing block while loading)', async () => {
    // detail null (loading) — title/author/description come from the block.
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    // Title appears (Mantine Modal title). Use a tolerant matcher — title may
    // appear in the modal header region.
    await expect.element(page.getByText('My App', { exact: false }).first()).toBeInTheDocument();
    await expect.element(page.getByText('by My App', { exact: false })).toBeInTheDocument();
    await expect.element(page.getByText('Does a thing.', { exact: false })).toBeInTheDocument();
  });

  test('open → renders the reviews section (reuses AppBlockReviews) with the app id + aggregate', async () => {
    mocks.detail = makeDetail({ avgRating: 4.2, reviewCount: 9 });
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    await expect.element(page.getByTestId('reviews-section')).toBeInTheDocument();
    expect(mocks.reviewsProps).toHaveBeenCalledWith(
      expect.objectContaining({ appBlockId: 'app-1', avgRating: 4.2, reviewCount: 9 })
    );
  });

  test('open → renders the scopes section with each approved scope + its description', async () => {
    mocks.detail = makeDetail({ scopes: ['user:read:self', 'ai:write:budgeted'] });
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    // The section heading.
    await expect.element(page.getByText(/this app can/i)).toBeInTheDocument();
    // Each scope id chip + friendly description.
    await expect.element(page.getByText('user:read:self', { exact: false })).toBeInTheDocument();
    await expect.element(
      page.getByText("Read the viewer's username and account status", { exact: false })
    ).toBeInTheDocument();
    await expect.element(page.getByText('ai:write:budgeted', { exact: false })).toBeInTheDocument();
  });

  test('open + no scopes → graceful "does not request any permissions"', async () => {
    mocks.detail = makeDetail({ scopes: [] });
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    await expect.element(
      page.getByText(/does not request any permissions/i)
    ).toBeInTheDocument();
  });

  test('open + screenshots present → renders the gallery images', async () => {
    mocks.detail = makeDetail({
      screenshots: [
        { index: 0, url: '/api/blocks/screenshot/app-1/0.png', contentType: 'image/png' },
        { index: 1, url: '/api/blocks/screenshot/app-1/1.webp', contentType: 'image/webp' },
      ],
    });
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    await expect.element(page.getByText(/screenshots/i)).toBeInTheDocument();
    // Both screenshot <img>s render with their public gated-route URLs.
    const imgs = Array.from(document.querySelectorAll('img')).filter((i) =>
      i.getAttribute('src')?.includes('/api/blocks/screenshot/app-1/')
    );
    expect(imgs.length).toBe(2);
  });

  test('open + NO screenshots → screenshots section gracefully absent (no heading, no imgs)', async () => {
    mocks.detail = makeDetail({ screenshots: [] });
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    // The scopes/reviews still render, but there's no screenshot section.
    await expect.element(page.getByTestId('reviews-section')).toBeInTheDocument();
    expect(page.getByText(/^screenshots$/i).query()).toBeNull();
    const shots = Array.from(document.querySelectorAll('img')).filter((i) =>
      i.getAttribute('src')?.includes('/api/blocks/screenshot/')
    );
    expect(shots.length).toBe(0);
  });

  test('detail-provided title/author override the listing block when loaded', async () => {
    mocks.detail = makeDetail({
      appName: 'Detail Author',
      manifest: { name: 'Detail Name', description: 'Detail description.' },
    });
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    await expect.element(page.getByText('by Detail Author', { exact: false })).toBeInTheDocument();
    await expect.element(page.getByText('Detail description.', { exact: false })).toBeInTheDocument();
  });
});
