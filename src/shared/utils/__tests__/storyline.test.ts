import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type { StorylineChapterPost, StorylineChapterRank } from '~/shared/utils/storyline';
import {
  compareStorylineChildren,
  getStorylineChapterRank,
  getStorylineChapterTombstone,
  storylineLevelAllowed,
  storylineShareMinChoices,
  toStorylineForkShares,
} from '~/shared/utils/storyline';

describe('storylineLevelAllowed', () => {
  it('judges a post by its most severe image', () => {
    // PG | R: an R image in an otherwise PG post is R.
    const pgAndR = NsfwLevel.PG | NsfwLevel.R;
    expect(storylineLevelAllowed({ postLevel: pgAndR, maxNsfwLevel: NsfwLevel.PG13 })).toBe(false);
    expect(storylineLevelAllowed({ postLevel: pgAndR, maxNsfwLevel: NsfwLevel.R })).toBe(true);
  });

  it('refuses an unrated post rather than treating it as PG', () => {
    expect(storylineLevelAllowed({ postLevel: 0, maxNsfwLevel: NsfwLevel.XXX })).toBe(false);
  });

  it('refuses Blocked under every ceiling', () => {
    expect(
      storylineLevelAllowed({ postLevel: NsfwLevel.Blocked, maxNsfwLevel: NsfwLevel.XXX })
    ).toBe(false);
  });

  it('accepts a post exactly at the ceiling', () => {
    expect(storylineLevelAllowed({ postLevel: NsfwLevel.X, maxNsfwLevel: NsfwLevel.X })).toBe(true);
  });
});

describe('getStorylineChapterRank', () => {
  const collaboratorIds = new Set([7]);

  it('derives endorsed from the current collaborator list, not from what was stored', () => {
    expect(getStorylineChapterRank({ canon: false, authorId: 7, collaboratorIds })).toBe(
      'endorsed'
    );
    expect(getStorylineChapterRank({ canon: false, authorId: 7, collaboratorIds: new Set() })).toBe(
      'community'
    );
  });

  it('canon wins over endorsement', () => {
    expect(getStorylineChapterRank({ canon: true, authorId: 7, collaboratorIds })).toBe('canon');
  });
});

describe('compareStorylineChildren', () => {
  const child = (
    chapterId: number,
    rank: StorylineChapterRank,
    readers: number,
    createdAt = new Date('2026-01-01')
  ) => ({ chapterId, rank, readers, createdAt });

  it('orders canon, then endorsed, then community by readers', () => {
    const children = [
      child(1, 'community', 5),
      child(2, 'community', 50),
      child(3, 'endorsed', 0),
      child(4, 'canon', 0),
      child(5, 'endorsed', 9),
    ];
    // An endorsed chapter with no readers still outranks a community chapter with 50.
    expect(children.sort(compareStorylineChildren).map((c) => c.chapterId)).toEqual([
      4, 5, 3, 2, 1,
    ]);
  });

  it('breaks ties oldest first so the order is stable', () => {
    const children = [
      child(9, 'community', 0, new Date('2026-03-01')),
      child(8, 'community', 0, new Date('2026-02-01')),
    ];
    expect(children.sort(compareStorylineChildren).map((c) => c.chapterId)).toEqual([8, 9]);
  });

  it('falls back to chapter id when everything else ties', () => {
    const children = [child(22, 'community', 0), child(21, 'community', 0)];
    expect(children.sort(compareStorylineChildren).map((c) => c.chapterId)).toEqual([21, 22]);
  });
});

describe('getStorylineChapterTombstone', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const post = (overrides: Partial<StorylineChapterPost> = {}): StorylineChapterPost => ({
    id: 100,
    userId: 1,
    nsfwLevel: NsfwLevel.PG,
    publishedAt: new Date('2026-10-01'),
    tosViolation: false,
    user: { bannedAt: null, deletedAt: null },
    ...overrides,
  });
  const base = {
    viewer: { id: 2 },
    maxNsfwLevel: NsfwLevel.R,
    browsingLevel: NsfwLevel.PG | NsfwLevel.PG13,
    blockedUserIds: new Set<number>(),
    now,
  };

  it('shows a published chapter within both limits', () => {
    expect(getStorylineChapterTombstone({ ...base, post: post() })).toBeNull();
  });

  it.each([
    ['deleted', { post: null }],
    ['removed', { post: post({ tosViolation: true }) }],
    ['removed', { post: post({ user: { bannedAt: now, deletedAt: null } }) }],
    ['removed', { post: post({ user: { bannedAt: null, deletedAt: now } }) }],
    // A block reads as unavailable, so a reader cannot learn that an author blocked them.
    ['unavailable', { post: post(), blockedUserIds: new Set([1]) }],
    ['unavailable', { post: post({ publishedAt: null }) }],
    ['unavailable', { post: post({ publishedAt: new Date('2026-11-01') }) }],
    ['unavailable', { post: post({ nsfwLevel: 0 }) }],
    ['aboveStoryRating', { post: post({ nsfwLevel: NsfwLevel.X }) }],
    ['browsingLevel', { post: post({ nsfwLevel: NsfwLevel.R }) }],
  ] as const)('tombstones as %s', (reason, overrides) => {
    expect(getStorylineChapterTombstone({ ...base, ...overrides })).toBe(reason);
  });

  it('holds the author and moderators to the ceiling', () => {
    const aboveCeiling = post({ nsfwLevel: NsfwLevel.X });
    expect(getStorylineChapterTombstone({ ...base, viewer: { id: 1 }, post: aboveCeiling })).toBe(
      'aboveStoryRating'
    );
    expect(
      getStorylineChapterTombstone({
        ...base,
        viewer: { id: 3, isModerator: true },
        post: aboveCeiling,
      })
    ).toBe('aboveStoryRating');
  });

  it('lets the author see their own unpublished chapter', () => {
    expect(
      getStorylineChapterTombstone({
        ...base,
        viewer: { id: 1 },
        post: post({ publishedAt: null }),
      })
    ).toBeNull();
  });

  it('lets a moderator see a removed chapter, but not a stranger', () => {
    const removed = post({ tosViolation: true });
    expect(
      getStorylineChapterTombstone({ ...base, viewer: { id: 3, isModerator: true }, post: removed })
    ).toBeNull();
    expect(getStorylineChapterTombstone({ ...base, viewer: undefined, post: removed })).toBe(
      'removed'
    );
  });

  it('shows a chapter whose placement was removed as removed to everyone but moderators', () => {
    const removed = { ...base, post: post(), removed: true };
    expect(getStorylineChapterTombstone(removed)).toBe('removed');
    expect(getStorylineChapterTombstone({ ...removed, viewer: undefined })).toBe('removed');
    // Its own author too: the removal was a decision about that chapter.
    expect(getStorylineChapterTombstone({ ...removed, viewer: { id: 1 } })).toBe('removed');
    expect(
      getStorylineChapterTombstone({ ...removed, viewer: { id: 3, isModerator: true } })
    ).toBeNull();
    // Reported ahead of a block, so the reason is the removal, not the reader's lists.
    expect(getStorylineChapterTombstone({ ...removed, blockedUserIds: new Set([1]) })).toBe(
      'removed'
    );
  });
  it('reports the most permanent reason when several apply', () => {
    // Taken down AND by a blocked author AND above the ceiling.
    expect(
      getStorylineChapterTombstone({
        ...base,
        post: post({ tosViolation: true, nsfwLevel: NsfwLevel.X }),
        blockedUserIds: new Set([1]),
      })
    ).toBe('removed');
    // Unpublished AND above the ceiling.
    expect(
      getStorylineChapterTombstone({
        ...base,
        post: post({ publishedAt: null, nsfwLevel: NsfwLevel.X }),
      })
    ).toBe('unavailable');
  });

  it("never hides an author's own chapter behind a block list that names them", () => {
    expect(
      getStorylineChapterTombstone({
        ...base,
        viewer: { id: 1 },
        post: post(),
        blockedUserIds: new Set([1]),
      })
    ).toBeNull();
  });

  it("lets a moderator see an unpublished chapter, and a banned author's", () => {
    const mod = { id: 3, isModerator: true };
    expect(
      getStorylineChapterTombstone({ ...base, viewer: mod, post: post({ publishedAt: null }) })
    ).toBeNull();
    expect(
      getStorylineChapterTombstone({
        ...base,
        viewer: mod,
        post: post({ user: { bannedAt: now, deletedAt: null } }),
      })
    ).toBeNull();
  });

  it('holds the author and moderators to their own browsing level', () => {
    const rRated = post({ nsfwLevel: NsfwLevel.R });
    expect(getStorylineChapterTombstone({ ...base, viewer: { id: 1 }, post: rRated })).toBe(
      'browsingLevel'
    );
    expect(
      getStorylineChapterTombstone({ ...base, viewer: { id: 3, isModerator: true }, post: rRated })
    ).toBe('browsingLevel');
  });

  it("shows the author their own unrated chapter as unavailable, not over the story's line", () => {
    expect(
      getStorylineChapterTombstone({ ...base, viewer: { id: 1 }, post: post({ nsfwLevel: 0 }) })
    ).toBe('unavailable');
  });
});

describe('storylineShareMinChoices', () => {
  // The default is 1: shares show from the first choice. Anything unparseable or below 1 falls back
  // to it.
  it.each([
    [undefined, 1],
    ['', 1],
    ['0', 1],
    ['-3', 1],
    ['1.5', 1],
    ['abc', 1],
    ['1e3', 1],
    ['1', 1],
    [' 7 ', 7],
    ['20', 20],
  ])('reads %j as %i', (raw, expected) => {
    expect(storylineShareMinChoices(raw)).toBe(expected);
  });
});

describe('toStorylineForkShares', () => {
  // The minimum is a dial: 1 shows from the first choice; above 1 it withholds counts and shares
  // until that many readers have chosen, so a few known readers' choices cannot be inferred.
  const forks = (pairs: Array<[number, number]>) => new Map(pairs);

  it('at the default minimum of 1, shows a single first choice in full', () => {
    expect(toStorylineForkShares(forks([[11, 1]]), 1)).toEqual({
      enough: true,
      total: 1,
      minChoices: 1,
      counts: { 11: 1 },
      shares: { 11: 1 },
    });
  });

  it('at a raised minimum of 5, gives only the total at 4 choices', () => {
    expect(
      toStorylineForkShares(
        forks([
          [11, 3],
          [12, 1],
        ]),
        5
      )
    ).toEqual({ enough: false, total: 4, minChoices: 5, counts: {}, shares: {} });
  });

  it('at a raised minimum of 5, shows counts and shares at 5 choices', () => {
    expect(
      toStorylineForkShares(
        forks([
          [11, 4],
          [12, 1],
        ]),
        5
      )
    ).toEqual({
      enough: true,
      total: 5,
      minChoices: 5,
      counts: { 11: 4, 12: 1 },
      shares: { 11: 0.8, 12: 0.2 },
    });
  });

  it('never claims enough, or divides by zero, with no readers', () => {
    expect(toStorylineForkShares(new Map(), 1)).toEqual({
      enough: false,
      total: 0,
      minChoices: 1,
      counts: {},
      shares: {},
    });
  });
});
