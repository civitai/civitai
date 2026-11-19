import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import { challengeCoverWhere, minorMatureImageVisibleSql } from '~/server/common/image-visibility';
import { minorContentNotRestrictedWhere } from '~/server/utils/minor-content-gate.sql';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { PG, PG13, R, X, XXX, Blocked } = NsfwLevel;
const PAST = new Date('2026-01-01T00:00:00Z');
const FUTURE = new Date('2999-01-01T00:00:00Z');

let h: Awaited<ReturnType<typeof startPglitePrisma>>;

// One clean row per shape, then one row per condition that fails exactly that condition.
type Cover = {
  needsReview: string | null;
  tosViolation: boolean;
  acceptableMinor: boolean;
  minor: boolean;
  nsfwLevel: number;
  postId: number | null;
};
const CLEAN: Cover = {
  needsReview: null,
  tosViolation: false,
  acceptableMinor: false,
  minor: false,
  nsfwLevel: PG,
  postId: null,
};
const COVERS: Record<string, Partial<Cover> & { id: number }> = {
  'clean, postless': { id: 1 },
  'clean, in a published public post': { id: 2, postId: 1 },
  'clean, minor-flagged at PG': { id: 3, minor: true },
  'held for review': { id: 10, needsReview: 'minor' },
  'a ToS violation': { id: 11, tosViolation: true },
  'an acceptable-minor image': { id: 12, acceptableMinor: true },
  unrated: { id: 13, nsfwLevel: 0 },
  Blocked: { id: 14, nsfwLevel: Blocked },
  'minor-flagged at R': { id: 15, minor: true, nsfwLevel: R },
  'in an unpublished post': { id: 16, postId: 2 },
  'in a scheduled post': { id: 17, postId: 3 },
  'in a Private post': { id: 18, postId: 4 },
};
const SHOWN = [
  'clean, postless',
  'clean, in a published public post',
  'clean, minor-flagged at PG',
];

beforeAll(async () => {
  h = await startPglitePrisma(`
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL DEFAULT 1, "publishedAt" timestamp(3), availability "Availability" NOT NULL DEFAULT 'Public');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT 1, "nsfwLevel" int NOT NULL DEFAULT 0,
      "tosViolation" boolean NOT NULL DEFAULT false, "postId" int REFERENCES "Post"(id),
      "needsReview" text, minor boolean NOT NULL DEFAULT false, "acceptableMinor" boolean NOT NULL DEFAULT false
    );
  `);
  await h.prisma.$executeRaw`INSERT INTO "Post" (id, "publishedAt", availability) VALUES
    (1, ${PAST}, 'Public'), (2, NULL, 'Public'), (3, ${FUTURE}, 'Public'), (4, ${PAST}, 'Private')`;
  for (const cover of Object.values(COVERS)) {
    const row = { ...CLEAN, ...cover };
    await h.prisma
      .$executeRaw`INSERT INTO "Image" (id, "nsfwLevel", "tosViolation", "postId", "needsReview", minor, "acceptableMinor")
      VALUES (${row.id}, ${row.nsfwLevel}, ${row.tosViolation}, ${row.postId}, ${row.needsReview}, ${row.minor}, ${row.acceptableMinor})`;
  }
});
afterAll(() => h?.stop());

describe('challengeCoverWhere', () => {
  const shownIds = async () =>
    (await h.prisma.image.findMany({ where: challengeCoverWhere(), select: { id: true } })).map(
      (r) => r.id
    );

  it.each(Object.keys(COVERS))('%s', async (name) => {
    expect((await shownIds()).includes(COVERS[name].id)).toBe(SHOWN.includes(name));
  });
});

describe('the Prisma minor content rule', () => {
  it('shows exactly the rows minorMatureImageVisibleSql shows to a signed-out viewer', async () => {
    const levels = [0, PG, PG13, R, X, XXX, Blocked];
    let id = 1000;
    for (const minor of [true, false])
      for (const level of levels)
        await h.prisma
          .$executeRaw`INSERT INTO "Image" (id, "nsfwLevel", minor) VALUES (${id++}, ${level}, ${minor})`;

    const viaPrisma = (
      await h.prisma.image.findMany({
        where: { id: { gte: 1000 }, ...minorContentNotRestrictedWhere() },
        select: { id: true },
      })
    ).map((r) => r.id);
    const viaSql = (
      await h.prisma.$queryRaw<{ id: number }[]>(
        Prisma.sql`SELECT id FROM "Image" i WHERE id >= 1000 AND ${minorMatureImageVisibleSql()} ORDER BY id`
      )
    ).map((r) => r.id);

    expect(viaPrisma.sort((a, b) => a - b)).toEqual(viaSql);
    // Both outcomes occur among minor rows, so a rule stuck at one answer cannot pass.
    expect(viaSql.length).toBeGreaterThan(levels.length);
    expect(viaSql.length).toBeLessThan(levels.length * 2);
  });
});
