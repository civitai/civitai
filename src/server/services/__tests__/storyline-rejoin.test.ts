import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
import { STORYLINE_GRAPH_LIMIT } from '~/shared/utils/storyline';
import { createFakeDb, type FakeDb } from './storyline-loop.fake-db';

/**
 * Rejoining branches through the real storyline service, on the in-memory database fake: who may
 * link two chapters, which links are refused, what a link writes, and how the reads see a chapter
 * with two parents.
 */

const blockedPairIds = vi.hoisted(() => ({ ids: [] as number[] }));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getAllHiddenForUser: async () => ({ hiddenImages: [], hiddenTags: [] }),
  getBlockedPairIds: async () => blockedPairIds.ids,
  HiddenUsers: { getCached: async () => [] },
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: async () => ({ emptyResult: false }),
}));

const {
  getStorylineChildren,
  getStorylineGraph,
  getStorylineLinkTargets,
  linkStorylineChapter,
  setCanonChapter,
} = await import('~/server/services/storyline.service');

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
  blockedPairIds.ids = [];
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

describe('linkStorylineChapter against a removal', () => {
  it('holds the two chapters until it commits, so a removal landing mid-link waits', async () => {
    db.removeBeforeNextEdge(R);
    await link(24, R);

    expect(edgesInto(R)).toEqual([
      [13, true],
      [24, true],
    ]);
    // Nothing was written onto a chapter that was already removed...
    expect(db.edgesOnRemoved()).toEqual([]);
    // ...and the removal still happened, once the link had committed.
    expect(db.row('storylineChapter', { id: R })?.removedAt).toBeInstanceOf(Date);
  });

  it('refuses a chapter a removal has committed, whatever an earlier read of it said', async () => {
    const before = db.rows('storylineChapterEdge');
    const real = dbMock.dbWrite.storylineChapter.findMany.getMockImplementation() as (
      args: unknown
    ) => Promise<{ removedAt: Date | null }[]>;
    // The read that ran before the removal committed: R still looks live to it.
    dbMock.dbWrite.storylineChapter.findMany.mockImplementationOnce((async (args: unknown) =>
      (await real(args)).map((c) => ({ ...c, removedAt: null }))) as never);
    db.update('storylineChapter', { id: R }, { removedAt: new Date() });

    const error = await link(24, R).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/removed/);
    expect(db.rows('storylineChapterEdge')).toEqual(before);
  });
});

describe('the fake db chapter lock', () => {
  const lock = (liveFilter: boolean) => {
    // The same statement as the service's, reflowed across lines as a formatter would leave it.
    const filter = liveFilter ? Prisma.sql`AND "removedAt" IS NULL` : Prisma.empty;
    return dbMock.dbWrite.$transaction(async (tx: typeof dbMock.dbWrite) => {
      await tx.$queryRaw(Prisma.sql`SELECT id
        FROM "StorylineChapter"
        WHERE id =
          ANY(${[R, 24]})
          ${filter}
        FOR SHARE`);
      return [R, 24].map((id) => db.isShareLocked(id));
    });
  };

  it('accepts a live-chapter lock whatever its whitespace and share-locks the chapters', async () => {
    expect(await lock(true)).toEqual([true, true]);
  });

  it('still refuses a lock that does not read live chapters only', async () => {
    await expect(lock(false)).rejects.toThrow(/not a live-chapter read/);
  });
});

describe('which chapters can be joined', () => {
  // A chapter's post the storyline's owner is not shown, whatever its own reader is shown.
  it.each([
    ['above the story rating', () => db.update('post', { id: R * 10 }, { nsfwLevel: 4 })],
    [
      'by a banned author',
      () => {
        db.update('post', { id: R * 10 }, { userId: STRANGER });
        db.update('user', { id: STRANGER }, { bannedAt: new Date() });
      },
    ],
    [
      'by a blocked author',
      () => {
        db.update('post', { id: R * 10 }, { userId: STRANGER });
        blockedPairIds.ids = [STRANGER];
      },
    ],
  ])('keeps a chapter %s out of the picker and refuses it from the link', async (_name, hide) => {
    hide();
    const before = db.rows('storylineChapterEdge');

    for (const caller of [
      { userId: OWNER, isModerator: false },
      // A moderator is offered what the owner is, not everything the moderator can see.
      { userId: MODERATOR, isModerator: true },
    ]) {
      const targets = await getStorylineLinkTargets({ parentChapterId: 24, ...caller });
      expect(targets.map((t) => t.chapterId)).toEqual([12, 13]);
      await expect(link(24, R, caller.userId, caller.isModerator)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringMatching(/cannot be joined/),
      });
    }
    expect(db.rows('storylineChapterEdge')).toEqual(before);
  });

  it('still offers and accepts the same chapter once it is shown to the owner', async () => {
    expect(
      (
        await getStorylineLinkTargets({ parentChapterId: 24, userId: MODERATOR, isModerator: true })
      ).map((t) => t.chapterId)
    ).toEqual([12, 13, R]);
    await link(24, R, MODERATOR, true);
    expect(edgesInto(R)).toHaveLength(2);
  });
});

describe('getStorylineLinkTargets', () => {
  // Branch P forks off trunk chapter 200 for three chapters; branch Q forks off chapter 5 and runs
  // 150 chapters; the trunk runs on to 260. From P's end every Q chapter after the first and every
  // trunk chapter after the fork's next one can be joined: well past the 100 the picker keeps.
  const longStory = () => {
    for (let id = 4; id <= 260; id++) {
      chapter(100 + id, id - 1);
      edge(100 + id, id === 4 ? 3 : 99 + id, false);
    }
    for (let i = 1; i <= 150; i++) {
      chapter(1000 + i, 4 + i);
      edge(1000 + i, i === 1 ? 105 : 999 + i, false);
    }
    for (let i = 1; i <= 3; i++) {
      chapter(2000 + i, 199 + i);
      edge(2000 + i, i === 1 ? 300 : 1999 + i, false);
    }
  };

  it('keeps the nearest chapters to the parent when there are more than it shows', async () => {
    longStory();
    const targets = await getStorylineLinkTargets({ parentChapterId: 2003, userId: OWNER });
    const depths = targets.map((t) => t.depth);

    expect(targets).toHaveLength(100);
    // Ahead of the parent, all of them: the trunk's 203 to 259, and then those behind it nearest first.
    expect(depths).toContain(259);
    expect(depths).toContain(204);
    // The shallow far end of the long branch is what the cap leaves out.
    expect(depths).not.toContain(7);
    expect(Math.min(...depths)).toBeGreaterThan(100);
    // Shown in story order.
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
  });

  it('only offers chapters the link accepts', async () => {
    longStory();
    const targets = await getStorylineLinkTargets({ parentChapterId: 2003, userId: OWNER });
    await expect(link(2003, targets[targets.length - 1].chapterId)).resolves.toBeUndefined();
  });
});

describe('getStorylineLinkTargets on the small story', () => {
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

describe('getStorylineGraph', () => {
  const graph = (viewer?: { id: number; isModerator?: boolean }, browsingLevel = PG) =>
    getStorylineGraph({ id: STORYLINE, viewer, browsingLevel });

  it('returns every chapter and link, both ways into a rejoin, tombstoned as the path is', async () => {
    await link(24, R);
    // The link from 13 is newer, so it comes second though its parent id is lower.
    db.update(
      'storylineChapterEdge',
      { chapterId: R, parentChapterId: 13 },
      { createdAt: new Date(Date.now() + 60_000) }
    );
    db.update('storylineChapter', { id: 22 }, { removedAt: new Date() });
    db.update('post', { id: 120 }, { nsfwLevel: 4 });

    const { rootChapterId, chapters, edges, truncated } = await graph();
    expect(rootChapterId).toBe(1);
    expect(truncated).toBe(false);
    expect(chapters.map((c) => c.chapterId)).toEqual([1, 2, 3, 11, 21, 12, 22, 13, 23, 24, R]);
    expect(edges.filter((e) => e.chapterId === R)).toEqual([
      { chapterId: R, parentChapterId: 24, canon: true },
      { chapterId: R, parentChapterId: 13, canon: true },
    ]);
    expect(edges).toHaveLength(11);

    const byId = new Map(chapters.map((c) => [c.chapterId, c]));
    expect(byId.get(22)).toMatchObject({ tombstone: 'removed', post: null });
    expect(byId.get(12)).toMatchObject({ tombstone: 'aboveStoryRating', post: null });
    // Control: the chapters after them are whole, so the branch stays followable.
    expect(byId.get(23)).toMatchObject({ tombstone: null, post: { id: 230, title: 'chapter 23' } });
    expect(byId.get(13)).toMatchObject({ tombstone: null, post: { id: 130 } });
  });

  it("tombstones by the reader: a moderator's view, the browsing level, a blocked author", async () => {
    db.update('storylineChapter', { id: 22 }, { removedAt: new Date() });
    db.update('storyline', { id: STORYLINE }, { maxNsfwLevel: ALL_LEVELS });
    db.update('post', { id: 120 }, { nsfwLevel: 2 });
    db.update('post', { id: 230 }, { userId: STRANGER });
    blockedPairIds.ids = [STRANGER];
    const tombstones = async (viewer?: { id: number; isModerator?: boolean }, level = PG) =>
      Object.fromEntries(
        (await graph(viewer, level)).chapters
          .filter((c) => [12, 22, 23].includes(c.chapterId))
          .map((c) => [c.chapterId, c.tombstone])
      );

    expect(await tombstones({ id: 77 })).toEqual({
      12: 'browsingLevel',
      22: 'removed',
      23: 'unavailable',
    });
    expect(await tombstones({ id: MODERATOR, isModerator: true }, ALL_LEVELS)).toEqual({
      12: null,
      22: null,
      23: 'unavailable',
    });
    // Control: nobody blocked, so only the level and the removal remain.
    blockedPairIds.ids = [];
    expect(await tombstones({ id: 77 })).toEqual({ 12: 'browsingLevel', 22: 'removed', 23: null });
  });

  it('says it is truncated only past the cap, not at it', async () => {
    // Storyline 1 has 11 chapters; a side branch brings it to exactly the cap.
    const extra = Array.from({ length: STORYLINE_GRAPH_LIMIT - 11 }, (_, i) => 1000 + i);
    extra.forEach((id, i) => {
      chapter(id, 3 + i);
      edge(id, i ? extra[i - 1] : 3, false);
    });
    expect(await graph()).toMatchObject({ truncated: false });
    expect((await graph()).chapters).toHaveLength(STORYLINE_GRAPH_LIMIT);

    chapter(5000, 3 + extra.length);
    edge(5000, extra[extra.length - 1], false);
    expect(await graph()).toMatchObject({ truncated: true });
  });

  it('reads at most the chapters nearest chapter 1, and only links between them', async () => {
    // A side branch long enough to pass the cap, whose far end also leads into R.
    const LONG = Array.from({ length: STORYLINE_GRAPH_LIMIT }, (_, i) => 1000 + i);
    LONG.forEach((id, i) => {
      chapter(id, 3 + i);
      edge(id, i ? LONG[i - 1] : 3, false);
    });
    edge(R, LONG[LONG.length - 1], false);

    const { chapters, edges, truncated } = await graph();
    expect(truncated).toBe(true);
    expect(chapters).toHaveLength(STORYLINE_GRAPH_LIMIT);
    const ids = new Set(chapters.map((c) => c.chapterId));
    expect(ids.has(R)).toBe(true);
    expect(ids.has(LONG[LONG.length - 1])).toBe(false);
    expect(edges.every((e) => ids.has(e.chapterId) && ids.has(e.parentChapterId))).toBe(true);
    expect(edges.filter((e) => e.chapterId === R).map((e) => e.parentChapterId)).toEqual([13]);
    // Every chapter read has its first parent read too, so the map reaches all of them.
    for (const c of chapters)
      if (c.chapterId !== 1) expect(edges.some((e) => e.chapterId === c.chapterId)).toBe(true);
  });
});
