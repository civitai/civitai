import { describe, expect, it } from 'vitest';

import {
  restrictedAudienceForViewer,
  type AppListingVisibility,
  type ListingAudienceFloor,
} from '~/shared/utils/app-listing-visibility';

/**
 * `restrictedAudienceForViewer` — WHO may be told how a listing is restricted.
 *
 * [NEW] behaviour: the function is introduced by this change, so these cases cannot be
 * watched to fail at the base ref (they fail to import there). The assurance behind them is
 * the mutation matrix in the PR body.
 *
 * Each viewer is the (floor, isOwner, isModerator) triple the store read actually hands the
 * function — the floor is what `resolveViewerAudienceFloor` resolves for that viewer. The
 * owner is modelled as an ordinary NON-tester account, so every owner cell is decided by
 * ownership alone and never by a cohort that happens to admit them.
 */
type Viewer = 'owner' | 'moderator' | 'tester' | 'regular' | 'anonymous';

const VIEWERS: Record<
  Viewer,
  { floor: ListingAudienceFloor; isOwner: boolean; isModerator: boolean }
> = {
  owner: { floor: 'public', isOwner: true, isModerator: false },
  moderator: { floor: 'moderators', isOwner: false, isModerator: true },
  tester: { floor: 'testers', isOwner: false, isModerator: false },
  regular: { floor: 'public', isOwner: false, isModerator: false },
  anonymous: { floor: 'public', isOwner: false, isModerator: false },
};

function derive(viewer: Viewer, visibility: AppListingVisibility | null, status = 'approved') {
  return restrictedAudienceForViewer({ visibility, status, ...VIEWERS[viewer] });
}

describe('restrictedAudienceForViewer — the full viewer × level matrix on an APPROVED listing', () => {
  // 🔴 LITERAL expectations, one row per viewer, columns in the order
  // private | moderators | testers | public | null.
  const LEVELS = ['private', 'moderators', 'testers', 'public', null] as const;
  const EXPECTED: Record<Viewer, ReadonlyArray<string | null>> = {
    owner: ['private', 'moderators', 'testers', null, null],
    moderator: ['private', 'moderators', 'testers', null, null],
    tester: [null, null, 'testers', null, null],
    regular: [null, null, null, null, null],
    anonymous: [null, null, null, null, null],
  };

  for (const viewer of Object.keys(EXPECTED) as Viewer[]) {
    LEVELS.forEach((level, i) => {
      it(`${viewer} × ${String(level)} → ${String(EXPECTED[viewer][i])}`, () => {
        expect(derive(viewer, level)).toBe(EXPECTED[viewer][i]);
      });
    });
  }
});

describe('restrictedAudienceForViewer — the boundaries that matter most', () => {
  it('🔴 `private` reaches ONLY the owner and moderators — never a tester, a regular user or anonymous', () => {
    // A `private` app stays openable by URL, so the people holding that URL must not be
    // told how it is restricted. No cohort is admitted by `private`, the tester's
    // included.
    expect(derive('tester', 'private')).toBeNull();
    expect(derive('regular', 'private')).toBeNull();
    expect(derive('anonymous', 'private')).toBeNull();
    expect(derive('owner', 'private')).toBe('private');
    expect(derive('moderator', 'private')).toBe('private');
  });

  it('a tester is told `testers` but NOT `moderators` (a level their cohort does not admit)', () => {
    expect(derive('tester', 'testers')).toBe('testers');
    expect(derive('tester', 'moderators')).toBeNull();
  });

  it('`public` and unset are never a restriction, for anyone', () => {
    for (const viewer of Object.keys(VIEWERS) as Viewer[]) {
      expect(derive(viewer, 'public')).toBeNull();
      expect(derive(viewer, null)).toBeNull();
    }
  });

  it('the REVIEW CEILING binds the cohort arm: a `testers` level on a `pending` listing tells a tester nothing', () => {
    // A row can carry a level set before it went back for review; above the ceiling the
    // level admits nobody, so the cohort arm must not tell a tester they are its audience.
    // The owner and moderators still learn the stored level.
    expect(derive('tester', 'testers', 'pending')).toBeNull();
    expect(derive('owner', 'testers', 'pending')).toBe('testers');
    expect(derive('moderator', 'testers', 'pending')).toBe('testers');
  });

  it('a `moderators` level on a `draft` (the review sandbox) is told to moderators, not testers', () => {
    expect(derive('moderator', 'moderators', 'draft')).toBe('moderators');
    expect(derive('tester', 'moderators', 'draft')).toBeNull();
  });

  it('an INELIGIBLE status tells the cohort nothing, even at a level the cohort would see', () => {
    // `removed` / `rejected` are moderation outcomes; `listingVisibleInStore` refuses them
    // first, and so must the badge.
    expect(derive('tester', 'testers', 'removed')).toBeNull();
    expect(derive('moderator', 'testers', 'removed')).toBe('testers');
  });
});
