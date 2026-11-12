import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Flipt from '~/server/flipt/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockLog = loggingMock.logToAxiom;

// The real SQL of the axis writes, against the real migration.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockIsFlipt } = vi.hoisted(() => ({ mockIsFlipt: vi.fn() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Flipt>()),
  isFlipt: mockIsFlipt,
}));
const { FLIPT_FEATURE_FLAGS } = await import('~/server/flipt/client');
const { writeRatedAxes, setModeratorAxes } = await import(
  '~/server/services/image-axis-rating.service'
);

const migration = readFileSync(
  join(
    process.cwd(),
    'packages/civitai-db-schema/prisma/migrations/20270104130000_image_axis_rating/migration.sql'
  ),
  'utf8'
);

let pg: PGlite;
const useDb = (db: PGlite) => {
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE TABLE "Image" (id int PRIMARY KEY);`);
  await pg.exec(migration);
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockLog.mockResolvedValue(undefined);
  mockIsFlipt.mockResolvedValue(true);
  useDb(pg);
  await pg.exec(`TRUNCATE "ImageAxisRating"; DELETE FROM "Image"; INSERT INTO "Image" VALUES (1);`);
});

const axes = (sexual: number, violence = 0) => ({
  sexual,
  violence,
  rater: 'radio-alpha',
  raterVersion: 'c0ffee',
});
const at = (minute: number) => new Date(Date.UTC(2026, 10, 12, 4, minute));
const scan = (sexual: number, minute: number, workflowId = `wf-${minute}`, violence = 0) =>
  writeRatedAxes({ imageId: 1, axes: axes(sexual, violence), workflowId, completedAt: at(minute) });

type Row = {
  source: string;
  sexualLevel: number | null;
  sexualHighWater: number | null;
  violenceLevel: number | null;
  languageLevel: number | null;
  rater: string | null;
  raterVersion: string | null;
  workflowId: string | null;
  setBy: number | null;
};
const row = async () =>
  (
    await pg.query<Row>(
      `SELECT source, "sexualLevel", "sexualHighWater", "violenceLevel", "languageLevel",
         rater, "raterVersion", "workflowId", "setBy"
       FROM "ImageAxisRating" WHERE "imageId" = 1`
    )
  ).rows[0];

describe('writeRatedAxes', () => {
  it('stores a scan as rated, with its rater checkpoint and no language axis', async () => {
    await scan(2, 0, 'wf-a', 1);
    expect(await row()).toEqual({
      source: 'rated',
      sexualLevel: 2,
      sexualHighWater: 2,
      violenceLevel: 1,
      languageLevel: null,
      rater: 'radio-alpha',
      raterVersion: 'c0ffee',
      workflowId: 'wf-a',
      setBy: null,
    });
  });

  // The ratchet: a lower re-scan is stored, but the high-water it would lower is kept.
  it('keeps the sexual high-water when a later scan rates lower', async () => {
    await scan(3, 0);
    await scan(1, 1);
    expect(await row()).toMatchObject({ sexualLevel: 1, sexualHighWater: 3 });
  });

  it('raises the sexual high-water when a later scan rates higher', async () => {
    await scan(1, 0);
    await scan(4, 1);
    expect(await row()).toMatchObject({ sexualLevel: 4, sexualHighWater: 4 });
  });

  it('never overwrites a moderator row', async () => {
    await setModeratorAxes({ imageId: 1, sexual: 0, violence: 0, moderatorId: 42 });
    // Later than the moderator's now(), so only the moderator guard can stop it.
    await writeRatedAxes({
      imageId: 1,
      axes: axes(4, 4),
      workflowId: 'wf-late',
      completedAt: new Date('2099-01-01T00:00:00Z'),
    });
    expect(await row()).toMatchObject({
      source: 'moderator',
      sexualLevel: 0,
      sexualHighWater: 0,
      violenceLevel: 0,
      workflowId: null,
    });
  });

  it('ignores a redelivered workflow and an older, lower one', async () => {
    await scan(2, 10, 'wf-new', 2);
    await scan(2, 10, 'wf-new', 2);
    await scan(1, 5, 'wf-old', 4);
    expect(await row()).toMatchObject({
      sexualLevel: 2,
      sexualHighWater: 2,
      violenceLevel: 2,
      workflowId: 'wf-new',
    });
  });

  // Arrival order must not decide the high-water: a late result still rated what it rated.
  it('lets an older, higher result raise only the high-water', async () => {
    await scan(2, 10, 'wf-new');
    await scan(4, 5, 'wf-old', 4);
    expect(await row()).toMatchObject({
      sexualLevel: 2,
      sexualHighWater: 4,
      violenceLevel: 0,
      workflowId: 'wf-new',
    });
  });

  it('writes nothing while the flag is off for the image', async () => {
    mockIsFlipt.mockResolvedValue(false);
    await scan(2, 0);
    expect(await row()).toBeUndefined();
    expect(mockIsFlipt).toHaveBeenCalledWith(FLIPT_FEATURE_FLAGS.IMAGE_AXIS_SHADOW_WRITE, '1');
  });

  it('resolves, writing nothing, when Flipt is unreachable', async () => {
    mockIsFlipt.mockRejectedValue(new Error('flipt down'));
    await expect(scan(2, 0)).resolves.toBeUndefined();
    expect(await row()).toBeUndefined();
  });

  it('writes nothing for a result with no completion time to order it by', async () => {
    await writeRatedAxes({ imageId: 1, axes: axes(2), workflowId: 'wf', completedAt: null });
    expect(await row()).toBeUndefined();
  });

  // The flag can be turned on before the migration is applied; the scan must not notice.
  it('resolves, and logs, when the table does not exist', async () => {
    const bare = new PGlite();
    await bare.exec(`CREATE TABLE "Image" (id int PRIMARY KEY); INSERT INTO "Image" VALUES (1);`);
    useDb(bare);

    await expect(scan(2, 0)).resolves.toBeUndefined();
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'image-axis-rating', type: 'error', imageId: 1 }),
      'webhooks'
    );
  });
});

describe('setModeratorAxes', () => {
  // Only a moderator lowers the high-water.
  it('lowers the level and the high-water together, and drops the rater', async () => {
    await scan(4, 0);
    await setModeratorAxes({ imageId: 1, sexual: 1, violence: 2, moderatorId: 42 });
    expect(await row()).toEqual({
      source: 'moderator',
      sexualLevel: 1,
      sexualHighWater: 1,
      violenceLevel: 2,
      languageLevel: null,
      rater: null,
      raterVersion: null,
      workflowId: null,
      setBy: 42,
    });
  });
});

describe('ImageAxisRating constraints', () => {
  const insert = (values: string) =>
    pg.exec(
      `INSERT INTO "ImageAxisRating" ("imageId", source, "sexualLevel", "sexualHighWater", rater, "raterVersion", "ratedAt") VALUES ${values}`
    );

  it('accepts a well-formed rated row', async () => {
    await expect(insert(`(1, 'rated', 2, 3, 'r', 'v', now())`)).resolves.toBeDefined();
  });

  it.each([
    ['a level above the scale', `(1, 'rated', 5, 5, 'r', 'v', now())`],
    ['a negative level', `(1, 'rated', -1, 0, 'r', 'v', now())`],
    ['a rated row without its rater', `(1, 'rated', 2, 2, NULL, NULL, now())`],
    ['a high-water below the level', `(1, 'rated', 3, 2, 'r', 'v', now())`],
    ['an image that does not exist', `(2, 'rated', 2, 2, 'r', 'v', now())`],
  ])('rejects %s', async (_, values) => {
    await expect(insert(values)).rejects.toThrow(/violates (check|foreign key) constraint/);
  });
});
