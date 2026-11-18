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

const { reorderPostImages } = await import('~/server/services/post.service');
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
      "updatedAt" timestamp(3)
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

  it('without `items` on a post with text, a listed held image keeps its index', async () => {
    const pgIds = await seedPost();
    await harness.pg.exec(`
      UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 1;
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
      'held for review',
      `UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 1`,
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

  it('on a capped request with a pinned image, a listed unrated upload cannot shift its rank', async () => {
    // 0-18 PG, 19 unrated upload Z (40), 20 XXX (1, above the cap), 21 PG Y (50): XXX is the 20th
    // rated image. Moving Y above Z would make it the 21st and drop the version level.
    const pg = Array.from({ length: 19 }, (_, i) => `(${10 + i}, ${POST}, ${PG}, ${i})`);
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "postId", "nsfwLevel", index) VALUES
        ${pg.join(', ')}, (40, ${POST}, 0, 19), (1, ${POST}, ${XXX}, 20), (50, ${POST}, ${PG}, 21);
    `);
    expect(await versionLevel()).toBe(XXX | PG);
    const pgIds = Array.from({ length: 19 }, (_, i) => 10 + i);
    const positions = await reorderPostImages({
      user: { id: OWNER } as SessionUser,
      servableLevels: sfwBrowsingLevelsFlag,
      id: POST,
      imageIds: [...pgIds, 50, 40, 1],
    });
    const after = await indexes();
    expect([after[40], after[1]]).toEqual([19, 20]);
    expect(positions.map((p) => p.id)).not.toContain(40);
    expect(await versionLevel()).toBe(XXX | PG);
  });

  // The editor gets every id from post.getImageIds, so a crafted list can name a hidden image.
  it.each([
    [
      'held for review, listed by the owner',
      `UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 1`,
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
