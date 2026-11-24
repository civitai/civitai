import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/env.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { writeTrainingDataRating } from '~/server/services/training-data-rating';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const SCHEMA = `
  CREATE TABLE "ModelFile" (id int PRIMARY KEY, url text NOT NULL, type text NOT NULL, metadata jsonb);
`;
const ZIP = 'https://storage.test/zip-1.zip';

/** The rating write against a real Postgres: which rows it moves, and which it leaves alone. */
describe('writeTrainingDataRating', () => {
  let db: Awaited<ReturnType<typeof startPglitePrisma>>;
  beforeAll(async () => {
    db = await startPglitePrisma(SCHEMA);
  });
  afterAll(async () => db?.stop());
  beforeEach(async () => {
    await db.pg.exec(`
      TRUNCATE "ModelFile";
      INSERT INTO "ModelFile" VALUES
        (1, '${ZIP}', 'Training Data', '{"fullyRated": false}'),
        (2, '${ZIP}', 'Training Data', '{"format": "Other"}'),
        (3, '${ZIP}', 'Training Data', NULL),
        (4, '${ZIP}', 'Training Data', '{"datasetArchive": {}, "fullyRated": false}'),
        (5, 'https://storage.test/other.zip', 'Training Data', '{"fullyRated": false}'),
        (6, '${ZIP}', 'Training Data', NULL);
    `);
  });
  const metadata = async (id: number) =>
    (
      await db.pg.query<{ metadata: unknown }>(`SELECT metadata FROM "ModelFile" WHERE id = $1`, [
        id,
      ])
    ).rows[0].metadata;

  it('writes a not fully rated result onto a row already stamped', async () => {
    await writeTrainingDataRating(db.prisma, {
      fileId: 1,
      url: ZIP,
      rating: { nsfwLevel: 1, fullyRated: false },
    });
    expect(await metadata(1)).toEqual({ nsfwLevel: 1, fullyRated: false });
  });

  it('leaves a row from before the stamp served: a not fully rated result does not land on it', async () => {
    await writeTrainingDataRating(db.prisma, {
      fileId: 2,
      url: ZIP,
      rating: { nsfwLevel: 1, fullyRated: false },
    });
    expect(await metadata(2)).toEqual({ format: 'Other' });
  });

  it('hides a row from before the stamp when a rated entry is mature, though others are unrated', async () => {
    await writeTrainingDataRating(db.prisma, {
      fileId: 6,
      url: ZIP,
      rating: { nsfwLevel: 1 | 4, fullyRated: false },
    });
    expect(await metadata(6)).toEqual({ nsfwLevel: 5, fullyRated: false });
  });

  it('moves a row from before the stamp up to fully rated', async () => {
    await writeTrainingDataRating(db.prisma, {
      fileId: 3,
      url: ZIP,
      rating: { nsfwLevel: 4, fullyRated: true },
    });
    expect(await metadata(3)).toEqual({ nsfwLevel: 4, fullyRated: true });
  });

  it('skips a Studio dataset row and a row whose zip was swapped', async () => {
    const rating = { nsfwLevel: 1, fullyRated: true };
    await writeTrainingDataRating(db.prisma, { fileId: 4, url: ZIP, rating });
    await writeTrainingDataRating(db.prisma, { fileId: 5, url: ZIP, rating });
    expect(await metadata(4)).toEqual({ datasetArchive: {}, fullyRated: false });
    expect(await metadata(5)).toEqual({ fullyRated: false });
  });
});
