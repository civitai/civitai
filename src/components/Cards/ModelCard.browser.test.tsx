import { describe, expect, test, vi, beforeEach } from 'vitest';

// =============================================================================
// ModelCard — feed review-indicator now reads batched membership, not the
// unbounded `user.getEngagedModels` endpoint (PR3 of the engaged-feed arc).
// =============================================================================
//
// What this test pins (the point of the migration):
//   * `ModelCardStats` derives its "reviewed" indicator from
//     `useEngagedModelMembership(id).isEngaged('Recommended')` — TRUE lights the
//     success-colored thumb (`data-reviewed="true"`), FALSE the neutral one.
//   * the legacy `trpc.user.getEngagedModels.useQuery` is NEVER called by the
//     card — a regression guard against reverting to the unbounded read that
//     drives the dp-prod event-loop-freeze.
//
// The card is a heavy feed leaf (~10 context/child deps). We render the REAL
// `ModelCardContent` + `ModelCardStats` and BOUNDARY-STUB the heavy children so
// the seam under test (membership -> hasReview -> ThumbsUpIcon) stays faithful.
// SHADOWED (not under test here): the image card, live-metric subscription, the
// context menu / remix / civitai-link affordances, the tip button.

// Shared mock state must be created inside `vi.hoisted` so the hoisted
// `vi.mock` factories can safely close over it (browser-mode mocker).
const mocks = vi.hoisted(() => {
  const state = { engaged: false };
  const membershipMock = vi.fn((_id: number) => ({
    isEngaged: (type: string) => (type === 'Recommended' ? state.engaged : false),
    types: state.engaged ? (['Recommended'] as const) : ([] as const),
    isLoading: false,
    isKnown: true,
  }));
  const getEngagedModelsUseQuery = vi.fn(() => ({ data: undefined }));
  return { state, membershipMock, getEngagedModelsUseQuery };
});

// --- controllable membership hook -------------------------------------------
vi.mock('~/hooks/useEngagedModelMembership', () => ({
  useEngagedModelMembership: (id: number) => mocks.membershipMock(id),
}));

// --- legacy endpoint spy (must never fire) ----------------------------------
vi.mock('~/utils/trpc', () => ({
  trpc: { user: { getEngagedModels: { useQuery: mocks.getEngagedModelsUseQuery } } },
}));

// --- boundary stubs for heavy children --------------------------------------
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false }),
}));
vi.mock('~/components/CardTemplates/AspectRatioImageCard', () => ({
  // Only the footer subtree carries ModelCardStats; render header+footer inline.
  AspectRatioImageCard: ({ header, footer }: any) => (
    <div>
      <div>{header}</div>
      <div>{footer}</div>
    </div>
  ),
}));
vi.mock('~/components/Metrics', () => ({
  // Render children with the `initial` metrics synchronously (no live sub).
  Metrics: ({ children, initial }: any) => children(initial),
  AnimatedCount: ({ value }: any) => <>{value}</>,
}));
vi.mock('~/components/Cards/ModelCardContext', () => ({
  useModelCardContext: () => ({ useModelVersionRedirect: false, activeBaseModels: undefined }),
}));
vi.mock('~/components/Cards/ModelCardContextMenu', () => ({ ModelCardContextMenu: () => null }));
vi.mock('~/components/Cards/components/RemixButton', () => ({ RemixButton: () => null }));
vi.mock('~/components/CivitaiLink/CivitaiLinkManageButton', () => ({
  CivitaiLinkManageButton: () => null,
}));
vi.mock('~/components/UserAvatar/UserAvatarSimple', () => ({ UserAvatarSimple: () => null }));
vi.mock('~/components/Model/ModelTypeBadge/ModelTypeBadge', () => ({ ModelTypeBadge: () => null }));
vi.mock('~/components/Buzz/InteractiveTipBuzzButton', () => ({
  InteractiveTipBuzzButton: ({ children }: any) => <>{children}</>,
  useBuzzTippingStore: () => 0,
}));
vi.mock('~/components/IntersectionObserver/ElementInView', () => ({
  useElementInView: () => true,
}));
vi.mock('~/components/Cards/model-card.utils', () => ({ getCardBaseModels: () => [] }));

import { renderWithProviders } from '../../../test/component-setup';
import { ModelCard } from '~/components/Cards/ModelCard';

// Minimal fixture — only the fields ModelCardContent/ModelCardStats read.
// thumbsUpCount>0 + locked:false is the gate that renders the review badge.
function makeData(): any {
  return {
    id: 123,
    name: 'Test Model',
    poi: false,
    minor: false,
    nsfw: false,
    locked: false,
    availability: 'Public',
    mode: null,
    type: 'Checkpoint',
    publishedAt: null,
    lastVersionAt: null,
    earlyAccessDeadline: null,
    cosmetic: null,
    hashes: [],
    canGenerate: false,
    images: [{}],
    user: { id: 99, username: 'creator' },
    version: { id: 456, baseModel: 'SD 1.5', trainingStatus: null },
    rank: {
      downloadCount: 0,
      collectedCount: 0,
      commentCount: 0,
      tippedAmountCount: 0,
      thumbsUpCount: 5,
      thumbsDownCount: 1,
    },
  };
}

async function reviewedAttr(): Promise<string | null> {
  let el: Element | null = null;
  await vi.waitFor(() => {
    el = document.querySelector('[data-reviewed]');
    expect(el).toBeTruthy();
  });
  return (el as unknown as Element).getAttribute('data-reviewed');
}

describe('ModelCard review indicator (batched membership)', () => {
  beforeEach(() => {
    mocks.state.engaged = false;
    mocks.membershipMock.mockClear();
    mocks.getEngagedModelsUseQuery.mockClear();
  });

  test('renders the reviewed indicator when the model is Recommended by the user', async () => {
    mocks.state.engaged = true;
    renderWithProviders(<ModelCard data={makeData()} />);
    expect(await reviewedAttr()).toBe('true');
    // reads membership for THIS model id, never the unbounded endpoint
    expect(mocks.membershipMock).toHaveBeenCalledWith(123);
    expect(mocks.getEngagedModelsUseQuery).not.toHaveBeenCalled();
  });

  test('does NOT mark reviewed when the model is not Recommended', async () => {
    mocks.state.engaged = false;
    renderWithProviders(<ModelCard data={makeData()} />);
    expect(await reviewedAttr()).toBe('false');
    expect(mocks.getEngagedModelsUseQuery).not.toHaveBeenCalled();
  });
});
