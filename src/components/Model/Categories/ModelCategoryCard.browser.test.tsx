import { describe, expect, test, vi, beforeEach } from 'vitest';

// =============================================================================
// ModelCategoryCard — review indicator reads batched membership
// (`useEngagedModelMembership`). The legacy unbounded `user.getEngagedModels`
// endpoint it replaced was deleted in PR4, so there is no longer a symbol to
// spy on for a negative regression guard.
// =============================================================================
//
// What this pins (the migration contract):
//   * the card derives its "reviewed" thumb from
//     `useEngagedModelMembership(id).isEngaged('Recommended')` — TRUE renders the
//     filled/success thumb, FALSE the neutral one. We surface `filled` via a
//     ThumbsIcon stub so the isEngaged -> hasReview -> ThumbsUpIcon wiring is
//     directly observable.
//   * membership is requested for THIS model id (not a whole-history read).
//
// We render the REAL exported `ModelCategoryCard`. To keep the mount tractable
// we pass `images: []` (skips the ImageGuard/menu/EdgeMedia block entirely) and
// `user.image: null` (skips the avatar tooltip), then boundary-stub the stat
// leaves + the required context hooks. SHADOWED: image guard, live metrics, the
// context menu, masonry/intersection wiring — none change the review seam.

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
  return { state, membershipMock };
});

// --- controllable membership hook -------------------------------------------
vi.mock('~/hooks/useEngagedModelMembership', () => ({
  useEngagedModelMembership: (id: number) => mocks.membershipMock(id),
}));

// --- context hooks ----------------------------------------------------------
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'me' }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ imageGeneration: false }),
}));
vi.mock('~/components/HiddenPreferences/HiddenPreferencesProvider', () => ({
  useHiddenPreferencesContext: () => ({ hiddenUsers: new Map(), hiddenModels: new Map() }),
}));
vi.mock('~/components/Model/Actions/ModelCardContextMenu', () => ({
  useModelCardContextMenu: () => ({ setMenuItems: vi.fn() }),
}));

// --- stat-leaf stubs --------------------------------------------------------
vi.mock('~/components/IntersectionObserver/ElementInView', () => ({
  ElementInView: ({ children }: any) => <div>{children}</div>,
  useElementInView: () => true,
}));
vi.mock('~/components/Metrics', () => ({
  Metrics: ({ children, initial }: any) => children(initial),
  AnimatedCount: ({ value }: any) => <>{value}</>,
}));
vi.mock('~/components/ThumbsIcon/ThumbsIcon', () => ({
  // Surface `filled` (= hasReview) as a queryable attribute.
  ThumbsUpIcon: ({ filled }: any) => <span data-thumbs-filled={String(!!filled)} />,
}));
vi.mock('~/components/IconBadge/IconBadge', () => ({
  IconBadge: ({ icon, children }: any) => (
    <span>
      {icon}
      {children}
    </span>
  ),
}));
vi.mock('~/components/CivitaiLink/CivitaiLinkManageButton', () => ({
  CivitaiLinkManageButton: () => null,
}));

import { renderWithProviders } from '../../../../test/component-setup';
import { ModelCategoryCard } from '~/components/Model/Categories/ModelCategoryCard';

// Minimal fixture — images:[] + user.image:null keep the mount to the stats path.
function makeData(): any {
  return {
    id: 321,
    name: 'Category Model',
    type: 'Checkpoint',
    status: 'Published',
    nsfw: false,
    minor: false,
    images: [],
    user: { id: 99, username: 'creator', image: null },
    earlyAccessDeadline: null,
    publishedAt: null,
    lastVersionAt: null,
    hashes: [],
    canGenerate: false,
    rank: { downloadCount: 0, thumbsUpCount: 5, commentCount: 0 },
  };
}

async function thumbsFilled(): Promise<string | null> {
  let el: Element | null = null;
  await vi.waitFor(() => {
    el = document.querySelector('[data-thumbs-filled]');
    expect(el).toBeTruthy();
  });
  return (el as unknown as Element).getAttribute('data-thumbs-filled');
}

describe('ModelCategoryCard review indicator (batched membership)', () => {
  beforeEach(() => {
    mocks.state.engaged = false;
    mocks.membershipMock.mockClear();
  });

  test('fills the review thumb when the model is Recommended by the user', async () => {
    mocks.state.engaged = true;
    renderWithProviders(<ModelCategoryCard data={makeData()} height={300} />);
    expect(await thumbsFilled()).toBe('true');
    expect(mocks.membershipMock).toHaveBeenCalledWith(321);
  });

  test('leaves the thumb unfilled when the model is not Recommended', async () => {
    mocks.state.engaged = false;
    renderWithProviders(<ModelCategoryCard data={makeData()} height={300} />);
    expect(await thumbsFilled()).toBe('false');
  });
});
