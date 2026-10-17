import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
import { createFakeDb, type FakeDb } from './storyline-loop.fake-db';

/**
 * Rejoining branches through the real storyline service, on the in-memory database fake: who may
 * link two chapters, which links are refused, what a link writes, and how the reads see a chapter
 * with two parents.
 */

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getAllHiddenForUser: async () => ({ hiddenImages: [], hiddenTags: [] }),
  getBlockedPairIds: async () => [],
  HiddenUsers: { getCached: async () => [] },
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: async () => ({ emptyResult: false }),
}));

const { getStorylineChildren, getStorylineLinkTargets, linkStorylineChapter, setCanonChapter } =
  await import('~/server/services/storyline.service');

const OWNER = 10;
const STRANGER = 20;
const MODERATOR = 40;
const STORYLINE = 1;
const OTHER_STORYLINE = 2;
const PG = 1;
const ALL_LEVELS = 31;

// Trunk 1 -> 2 -> 3, branch A (11, 12, 13) on the canon line, branch B (21, 22, 23, 24) off 3,
// and R (30) after A's end. Chapter 50 is in another storyline.
const TRUNK = [1, 2, 3];
const A = [11, 12, 13];
const B = [21, 22, 23, 24];
const R = 30;

let db: FakeDb;

const chapter = (id: number, depth: number, storylineId = STORYLINE) => {
  db.insert('post', {
    id: id * 10,
    userId: OWNER,
    title: `chapter ${id}`,
    nsfwLevel: PG,
    publishedAt: new Date(Date.now() - 60_000),
    tosViolation: false,
  });
  db.insert('storylineChapter', { id, storylineId, postId: id * 10, userId: OWNER, depth });
};
const edge = (chapterId: number, parentChapterId: number, canon: boolean) =>
  db.insert('storylineChapterEdge', { storylineId: STORYLINE, chapterId, parentChapterId, canon });

const link = (parentChapterId: number, chapterId: number, userId = OWNER, isModerator = false) =>
  linkStorylineChapter({ parentChapterId, chapterId, userId, isModerator });

const edgesInto = (chapterId: number) =>
  db
    .rows('storylineChapterEdge')
    .filter((e) => e.chapterId === chapterId)
    .map((e) => [e.parentChapterId, e.canon]);

beforeEach(() => {
  db = createFakeDb();
  db.install();
  for (const [id, username] of [
    [OWNER, 'storyteller'],
    [STRANGER, 'stranger'],
  ] as const)
    db.insert('user', { id, username, image: null, bannedAt: null, deletedAt: null });
  for (const id of [STORYLINE, OTHER_STORYLINE])
    db.insert('storyline', {
      id,
      userId: OWNER,
      title: `story ${id}`,
      status: 'Ongoing',
      whoCanContinue: 'Anyone',
      maxNsfwLevel: PG,
      tosViolation: false,
      createdAt: new Date(0),
      coverImageId: null,
      heroImageId: null,
      heroImagePosition: 50,
    });

  TRUNK.forEach((id, i) => chapter(id, i));
  A.forEach((id, i) => chapter(id, 3 + i));
  B.forEach((id, i) => chapter(id, 3 + i));
  chapter(R, 6);
  chapter(50, 0, OTHER_STORYLINE);
  edge(2, 1, true);
  edge(3, 2, true);
  edge(11, 3, true);
  edge(12, 11, true);
  edge(13, 12, true);
  edge(21, 3, false);
  edge(22, 21, false);
  edge(23, 22, false);
  edge(24, 23, false);
  edge(R, 13, true);
});

describe('linkStorylineChapter', () => {
  it("adds the chapter as a way on from the other branch's end, canon there, keeping its depth", async () => {
    await link(24, R);

    expect(edgesInto(R)).toEqual([
      [13, true],
      [24, true],
    ]);
    expect(db.row('storylineChapter', { id: R })?.depth).toBe(6);
    for (const parent of [13, 24]) {
      const children = await getStorylineChildren({
        chapterId: parent,
        viewer: undefined,
        browsingLevel: ALL_LEVELS,
        readersByChapterId: new Map(),
      });
      expect(children.map((c) => [c.chapterId, c.parentCount])).toEqual([[R, 2]]);
    }
  });

  it('is not canon from a parent that already has a canon way on', async () => {
    chapter(25, 7);
    edge(25, 24, true);
    await link(24, R);
    expect(edgesInto(R)).toEqual([
      [13, true],
      [24, false],
    ]);
  });

  it('lets a moderator link, and nobody else but the owner', async () => {
    const error = await link(24, R, STRANGER).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('UNAUTHORIZED');
    expect(edgesInto(R)).toHaveLength(1);

    await link(24, R, MODERATOR, true);
    expect(edgesInto(R)).toHaveLength(2);
  });

  it.each([
    ['a chapter on to itself', () => link(R, R), /cannot continue itself/],
    ['a chapter of another storyline', () => link(24, 50), /not found/],
    ['the first chapter', () => link(24, 1), /first chapter/],
    ['a loop', () => link(R, 11), /loop/],
    ['a skip along a route', () => link(3, R), /skip/],
    ['a link that exists', () => link(13, R), /already continues/],
    [
      'a removed chapter',
      async () => {
        db.update('storylineChapter', { id: R }, { removedAt: new Date() });
        return link(24, R);
      },
      /removed/,
    ],
    [
      'a link from a removed chapter',
      async () => {
        db.update('storylineChapter', { id: 24 }, { removedAt: new Date() });
        return link(24, R);
      },
      /removed/,
    ],
    [
      'a taken-down storyline',
      async () => {
        db.update('storyline', { id: STORYLINE }, { tosViolation: true });
        return link(24, R);
      },
      /taken down/,
    ],
  ])('refuses %s with a client error and writes nothing', async (_name, act, message) => {
    const before = db.rows('storylineChapterEdge');
    const error = await act().catch((e: unknown) => e);
    expect((error as Error).message).toMatch(message);
    expect((error as { code?: string }).code).toMatch(/^(BAD_REQUEST|NOT_FOUND)$/);
    expect(db.rows('storylineChapterEdge')).toEqual(before);
  });
});

describe('getStorylineLinkTargets', () => {
  it('lists exactly the chapters a link would be accepted to, in story order', async () => {
    const targets = await getStorylineLinkTargets({ parentChapterId: 24, userId: OWNER });
    // Not 1 (first chapter), 2, 3, 21-23 (before 24: a loop), 24 itself, or 11 (a skip round the fork at 3).
    expect(targets.map((t) => t.chapterId)).toEqual([12, 13, R]);
    expect(targets[2]).toMatchObject({ tombstone: null, post: { id: R * 10 } });

    // Control: every chapter left out is refused by the link itself, and one listed is accepted.
    for (const refused of [1, 2, 3, 11, 21, 22, 23])
      await expect(link(24, refused)).rejects.toThrow();
    await link(24, R);
    // Now 24 -> 12 or 13 would go round 24 -> R.
    const after = await getStorylineLinkTargets({ parentChapterId: 24, userId: OWNER });
    expect(after).toEqual([]);
  });

  it('offers nothing from a removed chapter, as the link would refuse it', async () => {
    db.update('storylineChapter', { id: 24 }, { removedAt: new Date() });
    await expect(
      getStorylineLinkTargets({ parentChapterId: 24, userId: OWNER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('is for the owner and moderators only', async () => {
    await expect(
      getStorylineLinkTargets({ parentChapterId: 24, userId: STRANGER })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('setCanonChapter on a chapter with two parents', () => {
  beforeEach(async () => {
    await link(24, R);
    db.update('storylineChapterEdge', { chapterId: R, parentChapterId: 24 }, { canon: false });
  });

  it('asks which parent instead of choosing one', async () => {
    await expect(setCanonChapter({ chapterId: R, userId: OWNER })).rejects.toThrow(/choose which/);
  });

  it("moves canon on the named parent's route only", async () => {
    await setCanonChapter({ chapterId: R, parentChapterId: 24, userId: OWNER });
    expect(edgesInto(R)).toEqual([
      [13, true],
      [24, true],
    ]);
  });

  it('still needs no parent for a chapter with one', async () => {
    chapter(14, 6);
    edge(14, 13, false);
    await setCanonChapter({ chapterId: 14, userId: OWNER });
    expect(db.row('storylineChapterEdge', { chapterId: R, parentChapterId: 13 })?.canon).toBe(
      false
    );
    expect(db.row('storylineChapterEdge', { chapterId: 14 })?.canon).toBe(true);
  });
});
