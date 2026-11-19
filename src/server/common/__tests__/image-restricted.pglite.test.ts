import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  imageNotRestrictedSql,
  imageNotRestrictedWhere,
  imageRestrictedSql,
  isImageNotRestricted,
  type RestrictableImage,
} from '~/server/common/image-visibility';
import { isRestrictedImage } from '~/shared/utils/restricted-image';
import { NsfwLevel } from '~/server/common/enums';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const UPLOADER = 7;
const OTHER = 8;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, "nsfwLevel" int NOT NULL, "modelRestricted" boolean);
    INSERT INTO "Image" VALUES
      (1, ${UPLOADER}, ${NsfwLevel.PG}, true),
      (2, ${UPLOADER}, ${NsfwLevel.PG13}, NULL),
      (3, ${UPLOADER}, ${NsfwLevel.R}, false),
      (4, ${UPLOADER}, ${NsfwLevel.R}, true),
      (5, ${UPLOADER}, ${NsfwLevel.XXX}, true),
      (6, ${UPLOADER}, ${NsfwLevel.X}, NULL),
      (7, ${OTHER}, ${NsfwLevel.X}, true),
      (8, -1, ${NsfwLevel.X}, true);
  `);
});
afterAll(() => db.close());

async function ids(where: Prisma.Sql, alias = 'i') {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM "Image" ${alias} WHERE ${where.text} ORDER BY id`,
    where.values
  );
  return rows.map((r) => r.id);
}

describe('imageNotRestrictedSql', () => {
  it('hides mature restricted images, and a NULL flag on a mature image, but never a SFW one', async () => {
    expect(await ids(imageNotRestrictedSql())).toEqual([1, 2, 3]);
  });

  it('shows the uploader their own restricted images, and only theirs', async () => {
    expect(await ids(imageNotRestrictedSql({ viewerId: UPLOADER }))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await ids(imageNotRestrictedSql({ viewerId: OTHER }))).toEqual([1, 2, 3, 7]);
  });

  it('treats a placeholder viewer id as nobody', async () => {
    expect(await ids(imageNotRestrictedSql({ viewerId: 0 }))).toEqual([1, 2, 3]);
    expect(await ids(imageNotRestrictedSql({ viewerId: -1 }))).toEqual([1, 2, 3]);
  });

  it('has an exact complement', async () => {
    expect(await ids(imageRestrictedSql())).toEqual([4, 5, 6, 7, 8]);
    expect(await ids(imageRestrictedSql({ viewerId: UPLOADER }))).toEqual([7, 8]);
  });

  it('applies every arm to the alias it is given', async () => {
    expect(await ids(imageNotRestrictedSql({ alias: 'img', viewerId: OTHER }), 'img')).toEqual([
      1, 2, 3, 7,
    ]);
  });
});

// The TS twins decide rows already fetched; they must agree with the SQL row for row.
describe('isImageNotRestricted', () => {
  it.each([undefined, UPLOADER, OTHER, -1])('matches the SQL for viewer %s', async (viewerId) => {
    const { rows } = await db.query<{
      id: number;
      userId: number;
      nsfwLevel: number;
      modelRestricted: boolean | null;
    }>(`SELECT * FROM "Image" ORDER BY id`);
    // The column is NOT NULL in production; the NULL rows here deliberately pin the twin's fail-closed arm.
    const shown = rows
      .filter((row) => isImageNotRestricted(row as RestrictableImage, viewerId))
      .map((row) => row.id);
    expect(shown).toEqual(await ids(imageNotRestrictedSql({ viewerId })));
  });

  it('counts a flag missing from the row as restricted on a mature image only', () => {
    expect(isRestrictedImage({ nsfwLevel: NsfwLevel.R, modelRestricted: undefined })).toBe(true);
    expect(isRestrictedImage({ nsfwLevel: NsfwLevel.PG, modelRestricted: undefined })).toBe(false);
  });
});

// Prisma can't run here, so the filter is pinned literally: each arm is the SQL helper's, and a
// mature level is any of the single levels `nsfwLevel` holds.
describe('imageNotRestrictedWhere', () => {
  const sfwOrUnflagged = [
    { nsfwLevel: { notIn: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX, NsfwLevel.Blocked] } },
    { modelRestricted: false },
  ];

  it('matches a SFW image or an unflagged one', () => {
    expect(imageNotRestrictedWhere()).toEqual({ OR: sfwOrUnflagged });
  });

  it("adds the uploader's own images, never for a placeholder viewer", () => {
    expect(imageNotRestrictedWhere({ viewerId: UPLOADER })).toEqual({
      OR: [...sfwOrUnflagged, { userId: UPLOADER }],
    });
    expect(imageNotRestrictedWhere({ viewerId: 0 })).toEqual({ OR: sfwOrUnflagged });
    expect(imageNotRestrictedWhere({ viewerId: -1 })).toEqual({ OR: sfwOrUnflagged });
  });
});
