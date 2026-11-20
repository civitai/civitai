import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { SessionUser } from '~/types/session';

// reorderPostImages against real Postgres (PGlite), with the version level read by the production
// SQL (`imageDerivedVersionLevels`). The editor lists only the images it shows
// (`getPostEditImages`): a reorder must leave the others where they are, or a hidden mature image
// can slide out of the version's first 20 and lower its level.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { reorderPostImages, keepSentIndex } = await import('~/server/services/post.service');
const { imageDerivedVersionLevels } = await import('~/server/services/nsfwLevels.service');

const OWNER = 7;
const MODEL = 1;
const VERSION = 2;
const POST = 3;
const PG = 1;
const XXX = 16;
// The owner on an uncapped request, so only the unlisted image is hidden from the editor.
const OWNER_EDITOR = { user: { id: OWNER } as SessionUser, servableLevels: allBrowsingLevelsFlag };

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
beforeAll(async () => {
  harness = await startPglitePrisma(`
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int, "publishedAt" timestamp(3)
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "postId" int, "nsfwLevel" int NOT NULL DEFAULT 1, index int, "needsReview" text,
      "userId" int NOT NULL DEFAULT ${OWNER}, "updatedAt" timestamp(3)
    );
    CREATE TABLE "PostText" (
      id int PRIMARY KEY, "postId" int NOT NULL, index int NOT NULL, "updatedAt" timestamp(3)
    );
  `);
  const { prisma } = harness;
  // The service's own where and data; only the returned columns are narrowed to this schema.
  dbMock.dbWrite.image.update.mockImplementation(((
    args: Parameters<typeof prisma.image.update>[0]
  ) => prisma.image.update({ ...args, select: { id: true } })) as never);
  dbMock.dbWrite.postText.update.mockImplementation(((
    args: Parameters<typeof prisma.postText.update>[0]
  ) => prisma.postText.update({ ...args, select: { id: true } })) as never);
  dbMock.dbWrite.image.findMany.mockImplementation(((
    ...args: Parameters<typeof prisma.image.findMany>
  ) => prisma.image.findMany(...args)) as never);
  dbMock.dbWrite.postText.findMany.mockImplementation(((
    ...args: Parameters<typeof prisma.postText.findMany>
  ) => prisma.postText.findMany(...args)) as never);
  dbMock.dbWrite.image.findFirst.mockImplementation(((
    ...args: Parameters<typeof prisma.image.findFirst>
  ) => prisma.image.findFirst(...args)) as never);
  dbMock.dbWrite.image.aggregate.mockImplementation(((
    ...args: Parameters<typeof prisma.image.aggregate>
  ) => prisma.image.aggregate(...args)) as never);
  dbMock.dbWrite.postText.count.mockImplementation(((
    ...args: Parameters<typeof prisma.postText.count>
  ) => prisma.postText.count(...args)) as never);
  dbMock.dbWrite.$transaction.mockImplementation(((writes: never[]) =>
    prisma.$transaction(writes)) as never);
  dbMock.dbRead.$queryRaw.mockImplementation(((...args: Parameters<typeof prisma.$queryRaw>) =>
    prisma.$queryRaw(...args)) as never);
});
afterAll(() => harness.stop());

beforeEach(async () => {
  await harness.pg.exec(`
    DELETE FROM "PostText"; DELETE FROM "Image"; DELETE FROM "Post";
    DELETE FROM "ModelVersion"; DELETE FROM "Model";
    INSERT INTO "Model" VALUES (${MODEL}, ${OWNER});
    INSERT INTO "ModelVersion" VALUES (${VERSION}, ${MODEL});
    INSERT INTO "Post" VALUES (${POST}, ${OWNER}, ${VERSION}, now() - interval '1 day');
  `);
});

/** Image 1 is XXX at index 0; images 10..30 are PG at 1..21, so the first 20 hold 1 and 10..28. */
async function seedPost() {
  const pgImages = Array.from({ length: 21 }, (_, i) => `(${10 + i}, ${POST}, ${PG}, ${i + 1})`);
  await harness.pg.exec(`
    INSERT INTO "Image" (id, "postId", "nsfwLevel", index) VALUES
      (1, ${POST}, ${XXX}, 0), ${pgImages.join(', ')};
  `);
  return Array.from({ length: 21 }, (_, i) => 10 + i);
}

/** 0-18 PG (10..28), 19 unrated upload (40), 20 XXX (1), 21 PG (50). */
async function seedUnratedLayout() {
  const pg = Array.from({ length: 19 }, (_, i) => `(${10 + i}, ${POST}, ${PG}, ${i})`);
  await harness.pg.exec(`
    INSERT INTO "Image" (id, "postId", "nsfwLevel", index) VALUES
      ${pg.join(', ')}, (40, ${POST}, 0, 19), (1, ${POST}, ${XXX}, 20), (50, ${POST}, ${PG}, 21);
  `);
}

const indexes = async () =>
  Object.fromEntries(
    (
      await harness.pg.query<{ id: number; index: number }>(`SELECT id, index FROM "Image"`)
    ).rows.map((row) => [row.id, row.index])
  );
const versionLevel = async () => (await imageDerivedVersionLevels([VERSION])).get(VERSION);

describe('reorderPostImages around images the editor does not list', () => {
  it('leaves a hidden XXX image at its index, and the version level unchanged', async () => {
    const pgIds = await seedPost();
    expect(await versionLevel()).toBe(XXX | PG);

    // The editor shows only the PG images (image 1 is held or above the cap); the owner reverses them.
    const positions = await reorderPostImages({
      ...OWNER_EDITOR,
      id: POST,
      imageIds: [...pgIds].reverse(),
    });

    const after = await indexes();
    expect(after[1]).toBe(0);
    expect(new Set(Object.values(after)).size).toBe(Object.keys(after).length);
    expect(after[30]).toBe(1); // the first listed image takes the first free index
    expect(await versionLevel()).toBe(XXX | PG);
    // The editor applies what is returned: every listed image at the index it was saved at.
    expect(positions).toEqual(
      [...pgIds].reverse().map((id) => ({ type: 'image', id, index: after[id] }))
    );
  });

  it('places listed items around it with `items` too, texts included', async () => {
    const pgIds = await seedPost();
    await harness.pg.exec(`INSERT INTO "PostText" VALUES (5, ${POST}, 0)`);
    await reorderPostImages({
      ...OWNER_EDITOR,
      id: POST,
      imageIds: [],
      items: [{ type: 'text', id: 5 }, ...pgIds.map((id) => ({ type: 'image' as const, id }))],
    });
    const after = await indexes();
    expect(after[1]).toBe(0);
    const text = (await harness.pg.query<{ index: number }>(`SELECT index FROM "PostText"`)).rows;
    expect(text).toEqual([{ index: 1 }]);
    expect(await versionLevel()).toBe(XXX | PG);
  });

  it('keeps a text the editor did not send at its index, clear of the listed items', async () => {
    const pgIds = await seedPost();
    // Text 6 sits at 2 and is not in `items` (another editor added it); text 5 is listed.
    await harness.pg.exec(`INSERT INTO "PostText" VALUES (5, ${POST}, 0), (6, ${POST}, 2)`);
    await reorderPostImages({
      ...OWNER_EDITOR,
      id: POST,
      imageIds: [],
      items: [{ type: 'text', id: 5 }, ...pgIds.map((id) => ({ type: 'image' as const, id }))],
    });
    const texts = (
      await harness.pg.query<{ id: number; index: number }>(`SELECT id, index FROM "PostText"`)
    ).rows;
    expect(texts.find((t) => t.id === 6)?.index).toBe(2);
    const all = [...Object.values(await indexes()), ...texts.map((t) => t.index)];
    expect(new Set(all).size).toBe(all.length);
  });

  it("without `items` on a post with text, a listed held image of another user's keeps its index", async () => {
    const pgIds = await seedPost();
    await harness.pg.exec(`
      UPDATE "Image" SET "needsReview" = 'csam', "userId" = 11 WHERE id = 1;
      INSERT INTO "PostText" VALUES (5, ${POST}, 22);
    `);
    const positions = await reorderPostImages({
      ...OWNER_EDITOR,
      id: POST,
      imageIds: [...pgIds].reverse().concat(1),
    });
    const after = await indexes();
    expect(after[1]).toBe(0);
    expect(new Set(Object.values(after)).size).toBe(Object.keys(after).length);
    expect(positions.map((p) => p.id)).not.toContain(1);
    const text = (await harness.pg.query<{ index: number }>(`SELECT index FROM "PostText"`)).rows;
    expect(text).toEqual([{ index: 22 }]);
    expect(await versionLevel()).toBe(XXX | PG);
  });

  it('a moderator moves a held image it lists: the hold does not pin it for them', async () => {
    const pgIds = await seedPost();
    await harness.pg.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 1`);
    await reorderPostImages({
      user: { id: 99, isModerator: true } as SessionUser,
      servableLevels: allBrowsingLevelsFlag,
      id: POST,
      imageIds: [...pgIds, 1],
    });
    expect((await indexes())[1]).toBe(21);
  });

  it('the owner moves their own held image it lists, as a moderator does', async () => {
    const pgIds = await seedPost();
    await harness.pg.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 1`);
    await reorderPostImages({ ...OWNER_EDITOR, id: POST, imageIds: [...pgIds, 1] });
    expect((await indexes())[1]).toBe(21);
  });

  it('control: with every image listed, positions are numbered from 0', async () => {
    const pgIds = await seedPost();
    await reorderPostImages({ ...OWNER_EDITOR, id: POST, imageIds: [...pgIds, 1] });
    const after = await indexes();
    expect(after[10]).toBe(0);
    expect(after[1]).toBe(21); // the owner moved the XXX image last, out of the first 20
    expect(await versionLevel()).toBe(PG);
  });

  it.each([
    [
      "held for review, another user's",
      `UPDATE "Image" SET "needsReview" = 'minor', "userId" = 11 WHERE id = 1`,
      allBrowsingLevelsFlag,
    ],
    ['above the request cap', '', sfwBrowsingLevelsFlag],
  ])('with `items`, leaves a listed image %s at its index', async (_l, hold, servableLevels) => {
    const pgIds = await seedPost();
    if (hold) await harness.pg.exec(hold);
    await harness.pg.exec(`INSERT INTO "PostText" VALUES (5, ${POST}, 22)`);
    const positions = await reorderPostImages({
      user: { id: OWNER } as SessionUser,
      servableLevels,
      id: POST,
      imageIds: [],
      items: [
        { type: 'text', id: 5 },
        ...pgIds.map((id) => ({ type: 'image' as const, id })),
        { type: 'image', id: 1 },
      ],
    });
    const after = await indexes();
    expect(after[1]).toBe(0);
    expect(positions.map((p) => p.id)).not.toContain(1);
    expect(await versionLevel()).toBe(XXX | PG);
  });

  it('on a capped request with nothing pinned, a listed unrated upload moves and is placed', async () => {
    // Images 10..12 are PG; 40 was just uploaded and not yet scanned (level 0).
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "postId", "nsfwLevel", index) VALUES
        (10, ${POST}, ${PG}, 0), (11, ${POST}, ${PG}, 1), (12, ${POST}, ${PG}, 2), (40, ${POST}, 0, 3);
    `);
    const positions = await reorderPostImages({
      user: { id: OWNER } as SessionUser,
      servableLevels: sfwBrowsingLevelsFlag,
      id: POST,
      imageIds: [40, 10, 11, 12],
    });
    expect((await indexes())[40]).toBe(0);
    expect(positions).toContainEqual({ type: 'image', id: 40, index: 0 });
  });

  it.each([
    ['a moderator who is not the owner leaves it at its index', { id: 99, isModerator: true }, 3],
    ['the owner moves it', { id: OWNER }, 0],
  ])("on a capped request, the owner's listed unrated upload: %s", async (_l, user, expected) => {
    await harness.pg.exec(`
        INSERT INTO "Image" (id, "postId", "nsfwLevel", index) VALUES
          (10, ${POST}, ${PG}, 0), (11, ${POST}, ${PG}, 1), (12, ${POST}, ${PG}, 2), (40, ${POST}, 0, 3);
      `);
    await reorderPostImages({
      user: user as SessionUser,
      servableLevels: sfwBrowsingLevelsFlag,
      id: POST,
      imageIds: [40, 10, 11, 12],
    });
    expect((await indexes())[40]).toBe(expected);
  });

  it('with a pinned image, an unrated upload moves within its stretch', async () => {
    // 0-18 PG, 19 unrated upload Z (40), 20 XXX (1, above the cap), 21 PG Y (50): XXX is the 20th
    // rated image now, and Z will count once its scan rates it.
    await seedUnratedLayout();
    const pgIds = Array.from({ length: 19 }, (_, i) => 10 + i);
    const positions = await reorderPostImages({
      user: { id: OWNER } as SessionUser,
      servableLevels: sfwBrowsingLevelsFlag,
      id: POST,
      imageIds: [40, ...pgIds, 50, 1],
    });
    const after = await indexes();
    expect([after[40], after[1]]).toEqual([0, 20]);
    expect(positions.map((p) => p.id)).toContain(40);
    expect(await versionLevel()).toBe(XXX | PG);
  });

  it('with a pinned image, refuses trading an unrated upload for a rated image across it', async () => {
    await seedUnratedLayout();
    const before = await indexes();
    const pgIds = Array.from({ length: 19 }, (_, i) => 10 + i);
    await expect(
      reorderPostImages({
        user: { id: OWNER } as SessionUser,
        servableLevels: sfwBrowsingLevelsFlag,
        id: POST,
        imageIds: [...pgIds, 50, 40, 1],
      })
    ).rejects.toThrow('This order could not be saved.');
    expect(await indexes()).toEqual(before);
    expect(await versionLevel()).toBe(XXX | PG);
  });

  it("with `items`, moving a text cannot shift a held image's rank among rated images", async () => {
    // Text 5 at 0, PG 10..28 at 1..19, held XXX image 1 at 20 (the 20th rated image), PG 50 at 21.
    const pg = Array.from({ length: 19 }, (_, i) => `(${10 + i}, ${POST}, ${PG}, ${i + 1}, NULL)`);
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "postId", "nsfwLevel", index, "needsReview") VALUES
        ${pg.join(', ')},
        (1, ${POST}, ${XXX}, 20, 'minor'), (50, ${POST}, ${PG}, 21, NULL);
      INSERT INTO "PostText" VALUES (5, ${POST}, 0);
    `);
    expect(await versionLevel()).toBe(XXX | PG);
    const pgIds = Array.from({ length: 19 }, (_, i) => 10 + i);
    await reorderPostImages({
      ...OWNER_EDITOR,
      id: POST,
      imageIds: [],
      items: [
        ...[...pgIds, 50].map((id) => ({ type: 'image' as const, id })),
        { type: 'text', id: 5 },
      ],
    });
    const after = await indexes();
    expect(after[1]).toBe(20);
    const text = (await harness.pg.query<{ index: number }>(`SELECT index FROM "PostText"`)).rows;
    const all = [...Object.values(after), ...text.map((t) => t.index)];
    expect(new Set(all).size).toBe(all.length);
    expect(await versionLevel()).toBe(XXX | PG);
  });

  it('uncapped, refuses moving a Blocked image across a held image, and writes nothing', async () => {
    // Blocked 60 at 0, PG 10..28 at 1..19, held XXX image 1 at 20 (the 20th rated image), PG 50 at 21.
    const pg = Array.from({ length: 19 }, (_, i) => `(${10 + i}, ${POST}, ${PG}, ${i + 1}, NULL)`);
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "postId", "nsfwLevel", index, "needsReview") VALUES
        (60, ${POST}, 32, 0, NULL), ${pg.join(', ')},
        (1, ${POST}, ${XXX}, 20, 'csam'), (50, ${POST}, ${PG}, 21, NULL);
    `);
    expect(await versionLevel()).toBe(XXX | PG);
    const pgIds = Array.from({ length: 19 }, (_, i) => 10 + i);
    const before = await indexes();
    // A lifted Blocked verdict would make image 60 count ahead of or behind the held image.
    await expect(
      reorderPostImages({ ...OWNER_EDITOR, id: POST, imageIds: [50, ...pgIds, 60] })
    ).rejects.toThrow('This order could not be saved.');
    expect(await indexes()).toEqual(before);
    expect(await versionLevel()).toBe(XXX | PG);
  });

  it("without `items` on a post with text, moving a Blocked image cannot shift a held image's rank", async () => {
    // Blocked 60 at 0, PG 10..28 at 1..19, held XXX 1 at 20, PG 50 at 21, a text at 22.
    const pg = Array.from({ length: 19 }, (_, i) => `(${10 + i}, ${POST}, ${PG}, ${i + 1}, NULL)`);
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "postId", "nsfwLevel", index, "needsReview") VALUES
        (60, ${POST}, 32, 0, NULL), ${pg.join(', ')},
        (1, ${POST}, ${XXX}, 20, 'minor'), (50, ${POST}, ${PG}, 21, NULL);
      INSERT INTO "PostText" VALUES (5, ${POST}, 22);
    `);
    const pgIds = Array.from({ length: 19 }, (_, i) => 10 + i);
    await reorderPostImages({ ...OWNER_EDITOR, id: POST, imageIds: [50, ...pgIds, 60] });
    const after = await indexes();
    expect([after[60], after[1]]).toEqual([0, 20]);
    const text = (await harness.pg.query<{ index: number }>(`SELECT index FROM "PostText"`)).rows;
    expect(text).toEqual([{ index: 22 }]);
    expect(await versionLevel()).toBe(XXX | PG);
  });

  it('refuses, and writes nothing, when indexes collide so placement would shift a held image', async () => {
    // Held 1 at 0 and held 2 at 3; rated 10 also at 0, 11 at 1, 12 at 2.
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "postId", "nsfwLevel", index, "needsReview") VALUES
        (1, ${POST}, ${XXX}, 0, 'minor'), (2, ${POST}, ${XXX}, 3, 'minor'),
        (10, ${POST}, ${PG}, 0, NULL), (11, ${POST}, ${PG}, 1, NULL), (12, ${POST}, ${PG}, 2, NULL);
    `);
    const before = await indexes();
    await expect(
      reorderPostImages({ ...OWNER_EDITOR, id: POST, imageIds: [10, 11, 12] })
    ).rejects.toThrow('This order could not be saved.');
    expect(await indexes()).toEqual(before);
  });

  it('saves an unchanged order with a Blocked image after a gap behind a held one', async () => {
    // PG 10 at 0, held XXX 1 at 3, Blocked 60 at 5.
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "postId", "nsfwLevel", index, "needsReview") VALUES
        (10, ${POST}, ${PG}, 0, NULL), (1, ${POST}, ${XXX}, 3, 'minor'), (60, ${POST}, 32, 5, NULL);
    `);
    await reorderPostImages({ ...OWNER_EDITOR, id: POST, imageIds: [10, 60] });
    const after = await indexes();
    expect(after[1]).toBe(3);
    expect(after[60]).toBeGreaterThan(3);
  });

  it('with `items`, moving only a text saves when a Blocked image is listed', async () => {
    // PG 10 at 0, Blocked 60 at 1, held XXX 1 at 2, text 5 at 3; the text moves to the front.
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "postId", "nsfwLevel", index, "needsReview") VALUES
        (10, ${POST}, ${PG}, 0, NULL), (60, ${POST}, 32, 1, NULL), (1, ${POST}, ${XXX}, 2, 'minor');
      INSERT INTO "PostText" VALUES (5, ${POST}, 3);
    `);
    await reorderPostImages({
      ...OWNER_EDITOR,
      id: POST,
      imageIds: [],
      items: [
        { type: 'text', id: 5 },
        { type: 'image', id: 10 },
        { type: 'image', id: 60 },
      ],
    });
    const after = await indexes();
    expect(after[1]).toBe(2);
    expect(after[10]).toBeLessThan(2);
    expect(after[60]).toBeLessThan(2);
  });

  it('saves either order of a visible image and a new upload placed after held images', async () => {
    // Visible A (10) at 0, held 1 and 2 at 1 and 2, the new upload (40) at 3 where addPostImage puts it.
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "postId", "nsfwLevel", index, "needsReview") VALUES
        (10, ${POST}, ${PG}, 0, NULL), (1, ${POST}, ${XXX}, 1, 'minor'),
        (2, ${POST}, ${XXX}, 2, 'csam'), (40, ${POST}, ${PG}, 3, NULL);
    `);
    await reorderPostImages({ ...OWNER_EDITOR, id: POST, imageIds: [40, 10] });
    await reorderPostImages({ ...OWNER_EDITOR, id: POST, imageIds: [10, 40] });
    const after = await indexes();
    expect([after[1], after[2]]).toEqual([1, 2]);
  });

  it("control: an upload left at a held image's index makes the post refuse a reorder", async () => {
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "postId", "nsfwLevel", index, "needsReview") VALUES
        (10, ${POST}, ${PG}, 0, NULL), (1, ${POST}, ${XXX}, 1, 'minor'),
        (2, ${POST}, ${XXX}, 2, 'csam'), (40, ${POST}, ${PG}, 2, NULL);
    `);
    await expect(
      reorderPostImages({ ...OWNER_EDITOR, id: POST, imageIds: [40, 10] })
    ).rejects.toThrow('This order could not be saved.');
  });

  // The editor gets every id from post.getImageIds, so a crafted list can name a hidden image.
  it.each([
    [
      "held for review, another user's, listed by the post owner",
      `UPDATE "Image" SET "needsReview" = 'csam', "userId" = 11 WHERE id = 1`,
      allBrowsingLevelsFlag,
    ],
    ['above the request cap, listed by the owner', '', sfwBrowsingLevelsFlag],
  ])(
    'leaves an image %s at its index, and the version level unchanged',
    async (_l, hold, servableLevels) => {
      const pgIds = await seedPost();
      if (hold) await harness.pg.exec(hold);
      await reorderPostImages({
        user: { id: OWNER } as SessionUser,
        servableLevels,
        id: POST,
        imageIds: [...pgIds, 1],
      });
      const after = await indexes();
      expect(after[1]).toBe(0);
      expect(new Set(Object.values(after)).size).toBe(Object.keys(after).length);
      expect(await versionLevel()).toBe(XXX | PG);
    }
  );
});

// The index an upload is written at (addPostImage) against real Postgres: a client index stands only
// when it is free and after every image an editor may not be served.
describe('keepSentIndex', () => {
  it.each([
    ['held for review', `(2, ${POST}, ${PG}, 2, 'minor')`],
    ['rated above the strictest cap', `(2, ${POST}, 8, 2, NULL)`],
  ])('refuses an index at or before an image %s, and keeps one after it', async (_l, row) => {
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "postId", "nsfwLevel", index, "needsReview") VALUES
        (10, ${POST}, ${PG}, 0, NULL), ${row};
    `);
    expect(await keepSentIndex(POST, 1)).toBe(false);
    expect(await keepSentIndex(POST, 2)).toBe(false);
    expect(await keepSentIndex(POST, 3)).toBe(true);
  });

  it('refuses an index another image holds, and negative or fractional ones', async () => {
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "postId", "nsfwLevel", index, "needsReview") VALUES
        (10, ${POST}, ${PG}, 0, NULL), (11, ${POST}, ${PG}, 5, NULL), (12, ${POST}, 0, 6, NULL);
    `);
    expect(await keepSentIndex(POST, 5)).toBe(false);
    expect(await keepSentIndex(POST, -1)).toBe(false);
    expect(await keepSentIndex(POST, 1.5)).toBe(false);
    // Visible, unrated and other review states do not hold an upload back.
    expect(await keepSentIndex(POST, 3)).toBe(true);
  });
});
