import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

// Stubbed: the real index module builds a Meilisearch client and prom collectors at load.
vi.mock('~/server/search-index/bounties.search-index', () => ({
  bountiesSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

vi.setConfig({ hookTimeout: 60_000 });

const { updateBountyNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { bountiesSearchIndex } = await import('~/server/search-index/bounties.search-index');

const IMAGELESS = 1;
const WITH_IMAGE = 2;
const db = { pg: null as unknown as PGlite };

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "Bounty" (
      "id" integer PRIMARY KEY,
      "nsfw" boolean NOT NULL DEFAULT false,
      "nsfwLevel" integer NOT NULL DEFAULT 0,
      "moderatorNsfwLevel" integer
    );
    CREATE TABLE "Image" ("id" integer PRIMARY KEY, "nsfwLevel" integer NOT NULL);
    CREATE TABLE "ImageConnection" ("imageId" integer, "entityType" text, "entityId" integer);
    CREATE TABLE "EntityModeration" (
      "entityType" text, "entityId" integer, "nsfwLevel" integer, "result" jsonb,
      "blocked" boolean NOT NULL DEFAULT false, "triggeredLabels" text[] NOT NULL DEFAULT '{}'
    );
    INSERT INTO "Image" VALUES (10, ${NsfwLevel.PG13});
    INSERT INTO "ImageConnection" VALUES (10, 'Bounty', ${WITH_IMAGE});
  `);
});
afterAll(() => db.pg?.close());

beforeEach(async () => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockImplementation(pgliteRaw(db.pg).queryRaw as never);
  await db.pg.exec(`DELETE FROM "Bounty"; DELETE FROM "EntityModeration";`);
});

const seed = (row: { id: number; nsfw: boolean; nsfwLevel: number; moderator: number | null }) =>
  db.pg.query(
    `INSERT INTO "Bounty" (id, nsfw, "nsfwLevel", "moderatorNsfwLevel") VALUES ($1, $2, $3, $4)`,
    [row.id, row.nsfw, row.nsfwLevel, row.moderator]
  );
const verdict = (id: number, level: number) =>
  db.pg.query(
    `INSERT INTO "EntityModeration" ("entityType", "entityId", "nsfwLevel", result)
     VALUES ('Bounty', $1, $2, '{"version":"1"}')`,
    [id, level]
  );
const storedLevel = async (id: number) =>
  (await db.pg.query<{ nsfwLevel: number }>(`SELECT "nsfwLevel" FROM "Bounty" WHERE id = $1`, [id]))
    .rows[0].nsfwLevel;

describe('updateBountyNsfwLevels on a bounty with no image linked', () => {
  it('stores the nsfw flag the text scan set, and queues the reindex', async () => {
    await seed({ id: IMAGELESS, nsfw: true, nsfwLevel: NsfwLevel.PG, moderator: null });
    await verdict(IMAGELESS, NsfwLevel.R);

    await updateBountyNsfwLevels([IMAGELESS]);

    expect(await storedLevel(IMAGELESS)).toBe(nsfwBrowsingLevelsFlag);
    expect(vi.mocked(bountiesSearchIndex.queueUpdate)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bountiesSearchIndex.queueUpdate)).toHaveBeenCalledWith([
      expect.objectContaining({ id: IMAGELESS }),
    ]);
  });

  it("stores a moderator's rating", async () => {
    await seed({ id: IMAGELESS, nsfw: false, nsfwLevel: NsfwLevel.PG, moderator: NsfwLevel.R });

    await updateBountyNsfwLevels([IMAGELESS]);

    expect(await storedLevel(IMAGELESS)).toBe(NsfwLevel.R);
  });

  it('stores a PG-13 text verdict, which sets no flag', async () => {
    await seed({ id: IMAGELESS, nsfw: false, nsfwLevel: NsfwLevel.PG, moderator: null });
    await verdict(IMAGELESS, NsfwLevel.PG13);

    await updateBountyNsfwLevels([IMAGELESS]);

    expect(await storedLevel(IMAGELESS)).toBe(NsfwLevel.PG13);
  });

  it('keeps its level when nothing rates it, rather than unrating it', async () => {
    await seed({ id: IMAGELESS, nsfw: false, nsfwLevel: NsfwLevel.PG13, moderator: null });

    await updateBountyNsfwLevels([IMAGELESS]);

    expect(await storedLevel(IMAGELESS)).toBe(NsfwLevel.PG13);
    expect(vi.mocked(bountiesSearchIndex.queueUpdate)).not.toHaveBeenCalledWith([
      expect.objectContaining({ id: IMAGELESS }),
    ]);
  });
});

describe('updateBountyNsfwLevels on a bounty with an image', () => {
  it('still takes the level from its images', async () => {
    await seed({ id: WITH_IMAGE, nsfw: false, nsfwLevel: NsfwLevel.PG, moderator: null });

    await updateBountyNsfwLevels([WITH_IMAGE]);

    expect(await storedLevel(WITH_IMAGE)).toBe(NsfwLevel.PG13);
  });
});
