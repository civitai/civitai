import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
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
  // getAppDetail query state, mirroring react-query's shape. Default = LOADING
  // (data undefined, isLoading true) so a test must opt in to a resolved/errored
  // state. `detail` is the resolved payload (only meaningful when status
  // 'success'); on 'success' it may be an actual object — including a
  // resolved-but-empty one — which is the load-bearing distinction for the M1
  // disclosure-correctness tests below.
  status: 'loading' as 'loading' | 'success' | 'error',
  detail: undefined as PublicAppDetail | undefined,
  reviewsProps: vi.fn(),
}));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-
// module-mock): a hand-written replacement silently breaks every importer the
// day '~/utils/trpc' grows an export this factory omits — the whole FILE then
// fails to load with 0 tests collected and no failing assertion.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    blocks: {
      getAppDetail: {
        // Faithful react-query shape: while loading/erroring `data` is
        // undefined (NOT null) — that's what lets the component distinguish
        // "resolved with empty scopes" from "not loaded".
        useQuery: () => ({
          data: mocks.status === 'success' ? mocks.detail : undefined,
          isLoading: mocks.status === 'loading',
          isError: mocks.status === 'error',
        }),
      },
      listMySubscriptions: {
        useQuery: () => ({ data: [] }),
      },
    },
  },
}));

/** Mark the detail query as resolved with this payload. */
function resolveDetail(detail: PublicAppDetail) {
  mocks.status = 'success';
  mocks.detail = detail;
}

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
    externalUrl: null,
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
    // The app's real owner chip. Distinct from `appName` (the OAuth client's
    // name, which in prod IS the app title) — see `getAppDetailAuthor`.
    owner: { id: 42, username: 'owner-user', image: null },
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
    externalUrl: null,
    ...overrides,
  };
}

const onClose = vi.fn();

beforeEach(() => {
  mocks.status = 'loading';
  mocks.detail = undefined;
  mocks.reviewsProps.mockClear();
  onClose.mockClear();
});

describe('AppDetailsModal', () => {
  test('closed → renders nothing visible', async () => {
    // 🔴 RENDER BARRIER FIRST. Without something to await, this whole test ran
    // its `.query()` assertions against a DOM that had not committed yet — it
    // passed no matter what the modal did. The sibling marker gives the
    // assertions a point in time to be true AT.
    renderWithProviders(
      <>
        <div data-testid="render-barrier" />
        <AppDetailsModal opened={false} onClose={onClose} block={makeBlock()} />
      </>
    );
    await expect.element(page.getByTestId('render-barrier')).toBeInTheDocument();
    // Mantine Modal renders no content when closed.
    expect(page.getByText('reviews for', { exact: false }).query()).toBeNull();
    expect(page.getByText('Does a thing.', { exact: false }).query()).toBeNull();
  });

  test('open + detail LOADING → title/description from the listing block, and NO author line', async () => {
    // The listing row (`AvailableBlock`) carries no owner, so there is no
    // attribution until `getAppDetail` resolves. Deliberate: a blank beats the
    // old `by {appName}`, which rendered the APP's OWN TITLE as its author.
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    // Title appears (Mantine Modal title). Use a tolerant matcher — title may
    // appear in the modal header region.
    await expect.element(page.getByText('My App', { exact: false }).first()).toBeInTheDocument();
    await expect.element(page.getByText('Does a thing.', { exact: false })).toBeInTheDocument();
    // Absence checked with `.elements()` AFTER the two positive awaits above —
    // `await expect.element(x).not.toBeInTheDocument()` polls until the
    // assertion passes, so with `.not` an empty pre-commit DOM satisfies it on
    // poll #0 and the check proves nothing.
    expect(page.getByTestId('app-detail-author').elements()).toHaveLength(0);
    expect(page.getByText('by My App', { exact: false }).elements()).toHaveLength(0);
  });

  test('🔴 open + detail RESOLVED → the author is the real OWNER, never appName/appId', async () => {
    // The prod bug: every approved block's OauthClient.name equals the app's own
    // title, so `by {appName}` showed "by My App" — the app crediting itself.
    resolveDetail(makeDetail());
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    const author = page.getByTestId('app-detail-author');
    await expect.element(author).toBeInTheDocument();
    await expect.element(author).toHaveAttribute('href', '/user/owner-user');
    await expect.element(page.getByText('by owner-user', { exact: false })).toBeInTheDocument();
    expect(page.getByText('by My App', { exact: false }).elements()).toHaveLength(0);
    expect(page.getByText('by app-1', { exact: false }).elements()).toHaveLength(0);
  });

  test('open + detail resolved with NO owner → no attribution line at all (not a fallback)', async () => {
    resolveDetail(makeDetail({ owner: null }));
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    // Positive barrier first, then the absence check.
    await expect.element(page.getByText('Does a thing.', { exact: false })).toBeInTheDocument();
    expect(page.getByTestId('app-detail-author').elements()).toHaveLength(0);
    expect(page.getByText('by My App', { exact: false }).elements()).toHaveLength(0);
  });

  test('open → renders the reviews section (reuses AppBlockReviews) with the app id + aggregate', async () => {
    resolveDetail(makeDetail({ avgRating: 4.2, reviewCount: 9 }));
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    await expect.element(page.getByTestId('reviews-section')).toBeInTheDocument();
    expect(mocks.reviewsProps).toHaveBeenCalledWith(
      expect.objectContaining({ appBlockId: 'app-1', avgRating: 4.2, reviewCount: 9 })
    );
  });

  test('open → renders the scopes section with each approved scope + its description', async () => {
    resolveDetail(makeDetail({ scopes: ['user:read:self', 'ai:write:budgeted'] }));
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

  test('open + no scopes (RESOLVED empty) → graceful "does not request any permissions"', async () => {
    resolveDetail(makeDetail({ scopes: [] }));
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    await expect.element(
      page.getByText(/does not request any permissions/i)
    ).toBeInTheDocument();
  });

  test('open + screenshots present → renders the gallery images', async () => {
    resolveDetail(makeDetail({
      screenshots: [
        { index: 0, url: '/api/blocks/screenshot/app-1/0.png', contentType: 'image/png' },
        { index: 1, url: '/api/blocks/screenshot/app-1/1.webp', contentType: 'image/webp' },
      ],
    }));
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    await expect.element(page.getByText(/screenshots/i)).toBeInTheDocument();
    // Both screenshot <img>s render with their public gated-route URLs.
    const imgs = Array.from(document.querySelectorAll('img')).filter((i) =>
      i.getAttribute('src')?.includes('/api/blocks/screenshot/app-1/')
    );
    expect(imgs.length).toBe(2);
  });

  test('open + NO screenshots → screenshots section gracefully absent (no heading, no imgs)', async () => {
    resolveDetail(makeDetail({ screenshots: [] }));
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    // The scopes/reviews still render, but there's no screenshot section.
    await expect.element(page.getByTestId('reviews-section')).toBeInTheDocument();
    expect(page.getByText(/^screenshots$/i).query()).toBeNull();
    const shots = Array.from(document.querySelectorAll('img')).filter((i) =>
      i.getAttribute('src')?.includes('/api/blocks/screenshot/')
    );
    expect(shots.length).toBe(0);
  });

  test('detail-provided title/description override the listing block when loaded', async () => {
    resolveDetail(makeDetail({
      // `appName` is deliberately set to something author-shaped: it must NOT
      // reach the author slot no matter how plausible it looks.
      appName: 'Detail Author',
      owner: { id: 42, username: 'real-owner', image: null },
      manifest: { name: 'Detail Name', description: 'Detail description.' },
    }));
    renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

    await expect.element(page.getByText('Detail description.', { exact: false })).toBeInTheDocument();
    await expect.element(page.getByText('by real-owner', { exact: false })).toBeInTheDocument();
    expect(page.getByText('by Detail Author', { exact: false }).elements()).toHaveLength(0);
  });

  // ── M1 (audit, REQUIRED): disclosure correctness ───────────────────────────
  // The scopes disclosure must distinguish FAILED-to-load from RESOLVED-empty.
  // A failed `getAppDetail` (retry:false) must NOT silently render the
  // reassuring "does not request any permissions" copy — that's a misleading
  // security-relevant claim about an app whose scopes we never actually read.
  describe('M1 — scopes disclosure distinguishes failed vs empty vs loading', () => {
    test('query ERROR → explicit error state, and NOT the "no permissions" copy', async () => {
      mocks.status = 'error';
      mocks.detail = undefined;
      renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

      // The "This app can…" heading is still present, but the body is the error
      // state — NOT the definitive "no permissions" disclosure.
      await expect.element(page.getByText(/couldn.?t load full details/i).first()).toBeInTheDocument();
      expect(page.getByText(/does not request any permissions/i).query()).toBeNull();
    });

    test('query LOADING → loading state, NOT the empty/error copy', async () => {
      // default state is 'loading'
      renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

      // While loading we say NEITHER "no permissions" NOR the error copy — the
      // scopes verdict is simply not yet known.
      await expect.element(page.getByText(/this app can/i)).toBeInTheDocument();
      expect(page.getByText(/does not request any permissions/i).query()).toBeNull();
      expect(page.getByText(/couldn.?t load full details/i).query()).toBeNull();
    });

    test('query RESOLVED with empty scopes → the legit "no permissions" copy', async () => {
      resolveDetail(makeDetail({ scopes: [] }));
      renderWithProviders(<AppDetailsModal opened onClose={onClose} block={makeBlock()} />);

      await expect.element(page.getByText(/does not request any permissions/i)).toBeInTheDocument();
      // And NOT the error copy.
      expect(page.getByText(/couldn.?t load full details/i).query()).toBeNull();
    });
  });

  // ── L2 (audit): prefer the RESOLVED aggregate, no stale `??` fall-through ───
  describe('L2 — resolved aggregate is authoritative (null is "no rating", not stale)', () => {
    test('detail resolved with avgRating null while listing block.avgRating non-null → reviews gets the RESOLVED null, not the stale listing value', async () => {
      resolveDetail(makeDetail({ avgRating: null, reviewCount: 0 }));
      renderWithProviders(
        // listing row carries a stale non-null aggregate
        <AppDetailsModal
          opened
          onClose={onClose}
          block={makeBlock({ avgRating: 4.7, reviewCount: 31 })}
        />
      );

      await expect.element(page.getByTestId('reviews-section')).toBeInTheDocument();
      // The reviews component must receive the RESOLVED null (not 4.7 / 31).
      expect(mocks.reviewsProps).toHaveBeenCalledWith(
        expect.objectContaining({ avgRating: null, reviewCount: 0 })
      );
    });

    test('while LOADING (detail undefined) the listing aggregate is used (fallback path)', async () => {
      // default loading state
      renderWithProviders(
        <AppDetailsModal
          opened
          onClose={onClose}
          block={makeBlock({ avgRating: 4.7, reviewCount: 31 })}
        />
      );

      await expect.element(page.getByTestId('reviews-section')).toBeInTheDocument();
      expect(mocks.reviewsProps).toHaveBeenCalledWith(
        expect.objectContaining({ avgRating: 4.7, reviewCount: 31 })
      );
    });
  });
});
