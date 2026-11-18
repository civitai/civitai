import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModeModule from '~/server/services/text-scan/mode';
import { getTextScanMode } from '~/server/services/text-scan/mode';

// Unit tests for bounty lock enforcement — locks come from the stored row, never from the
// client payload. bounty.service.ts has a large import graph, so its transitive
// service/db/queue dependencies are stubbed out below. Mirrors the mock scaffold used in
// model-locked-properties.service.test.ts.

// The old fixture spread its `tx` into `dbWrite`, so a model reached through the transaction and
// the same model reached directly were one object. The canonical `$transaction` default runs the
// callback against `dbMock.dbWrite`, which keeps that identity.
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const { CHECKED_URLS } = vi.hoisted(() => ({ CHECKED_URLS: ['checked-before-tx'] }));
const { mockEvaluateContent, mockThrowOnBlockedLinkDomain, mockBuzzTransaction } = vi.hoisted(
  () => ({
    mockEvaluateContent: vi.fn(),
    mockThrowOnBlockedLinkDomain: vi.fn(),
    mockBuzzTransaction: vi.fn(),
  })
);

// Pinned per test: 'off' by default keeps the profanity tests about the path they were written for.
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
}));
vi.mock('~/libs/profanity-simple', () => ({
  createProfanityFilter: () => ({ evaluateContent: mockEvaluateContent }),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: mockThrowOnBlockedLinkDomain,
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  checkEntityImageKeys: vi.fn(async () => CHECKED_URLS),
  createEntityImages: vi.fn(async () => []),
  updateEntityImages: vi.fn(async () => []),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createMultiAccountBuzzTransaction: mockBuzzTransaction,
  getUserBuzzAccount: vi.fn(async () => [{ balance: 1_000_000 }]),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/redis/caches', () => ({
  userBountyCountCache: { refresh: vi.fn() },
}));
vi.mock('~/server/search-index/bounties.search-index', () => ({
  bountiesSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/search-index/SearchIndexUpdate', () => ({
  SearchIndexUpdate: { queueUpdate: vi.fn() },
}));

import {
  addBenefactorUnitAmount,
  applyBountyContentChange,
  updateBountyById,
  upsertBounty,
} from '~/server/services/bounty.service';
import { constants } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import { bountyNsfwFlagLevel, ratedLevel } from '~/server/services/bounty-rated-level';
import { loadRatingReviewSubject } from '~/server/services/rating-review.entities';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import {
  checkEntityImageKeys,
  createEntityImages,
  updateEntityImages,
} from '~/server/services/image.service';

const BOUNTY_ID = 55;
const OWNER_ID = 7;
const MODERATOR_ID = 9;

// updateBountyById reads `existing` inside the transaction; upsertBounty reads the stored
// locks up front via dbRead. Both are pointed at the same row here.
function mockStored({
  lockedProperties = [] as string[],
  complete = false,
  poi = false,
  meta = null as unknown,
  details = null as unknown,
  nsfw = false,
  moderatorNsfwLevel = null as number | null,
}: {
  lockedProperties?: string[];
  complete?: boolean;
  poi?: boolean;
  meta?: unknown;
  details?: unknown;
  nsfw?: boolean;
  moderatorNsfwLevel?: number | null;
} = {}) {
  mockDbRead.bounty.findUnique.mockResolvedValue({ lockedProperties });
  mockDbWrite.bounty.findUniqueOrThrow.mockResolvedValue({
    id: BOUNTY_ID,
    details,
    entryLimit: null,
    complete,
    poi,
    meta,
    lockedProperties,
    nsfw,
    moderatorNsfwLevel,
    _count: { entries: 0 },
  });
}

function updateData() {
  return mockDbWrite.bounty.update.mock.calls.at(-1)?.[0]?.data ?? {};
}

function createData() {
  return mockDbWrite.bounty.create.mock.calls.at(-1)?.[0]?.data ?? {};
}

const baseUpdate = {
  id: BOUNTY_ID,
  userId: OWNER_ID,
  name: 'A bounty',
  description: 'Some description',
  type: 'ModelCreation',
  details: {},
  startsAt: new Date('2026-01-01'),
  expiresAt: new Date('2026-02-01'),
  tags: undefined,
  files: undefined,
  images: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTextScanMode).mockResolvedValue('off');
  mockStored();
  mockEvaluateContent.mockReturnValue({ shouldMarkNSFW: false });
  mockDbWrite.bounty.update.mockResolvedValue({ id: BOUNTY_ID, userId: OWNER_ID });
  mockDbWrite.bounty.create.mockResolvedValue({ id: BOUNTY_ID, userId: OWNER_ID });
});

describe('updateBountyById — images', () => {
  it('checks the image upload keys before opening the transaction', async () => {
    const images = [{ url: '00000000-0000-4000-8000-000000000000' }];
    await updateBountyById({ ...baseUpdate, images, userId: MODERATOR_ID } as never);

    expect(checkEntityImageKeys).toHaveBeenCalledWith({ images, userId: MODERATOR_ID });
    expect(vi.mocked(checkEntityImageKeys).mock.invocationCallOrder[0]).toBeLessThan(
      mockDbWrite.$transaction.mock.invocationCallOrder[0]
    );
    expect(vi.mocked(updateEntityImages).mock.calls[0][0]).toMatchObject({
      userId: MODERATOR_ID,
      keysCheckedFor: CHECKED_URLS,
    });
  });
});

describe('updateBountyById — lock enforcement', () => {
  it('strips a DB-locked field even when the client claims no locks', async () => {
    mockStored({ lockedProperties: ['nsfw'] });

    await updateBountyById({ ...baseUpdate, nsfw: false, lockedProperties: [] } as never);

    const data = updateData();
    expect(data).not.toHaveProperty('nsfw');
  });

  it('never lets a non-moderator write lockedProperties — the stored locks must survive', async () => {
    // Passing the client array through to the write would replace the stored locks with [],
    // permanently unlocking the bounty.
    mockStored({ lockedProperties: ['nsfw', 'poi'] });

    await updateBountyById({
      ...baseUpdate,
      nsfw: true,
      poi: true,
      lockedProperties: [],
    } as never);

    const data = updateData();
    expect(data).not.toHaveProperty('lockedProperties');
    expect(data).not.toHaveProperty('nsfw');
    expect(data).not.toHaveProperty('poi');
  });

  it('ignores locks the client claims — only the stored row decides what is locked', async () => {
    await updateBountyById({ ...baseUpdate, nsfw: true, lockedProperties: ['nsfw'] } as never);

    const data = updateData();
    expect(data.nsfw).toBe(true);
    expect(data).not.toHaveProperty('lockedProperties');
  });

  it('lets a moderator write lockedProperties and the locked values themselves', async () => {
    mockStored({ lockedProperties: ['nsfw'] });

    await updateBountyById({
      ...baseUpdate,
      userId: MODERATOR_ID,
      isModerator: true,
      nsfw: false,
      lockedProperties: ['nsfw', 'poi'],
    } as never);

    const data = updateData();
    expect(data.nsfw).toBe(false);
    expect(data.lockedProperties).toEqual(['nsfw', 'poi']);
  });

  it('reads the stored locks from the row it is about to update', async () => {
    await updateBountyById({ ...baseUpdate } as never);

    expect(mockDbWrite.bounty.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ lockedProperties: true }) })
    );
  });
});

describe('updateBountyById — a moderator rating against a new nsfw flag', () => {
  type Row = { nsfw: boolean; moderatorNsfwLevel: number | null };
  const modEdit = { ...baseUpdate, userId: MODERATOR_ID, isModerator: true, nsfw: true };
  const applied = (stored: Row): Row => {
    const data = updateData();
    return {
      nsfw: data.nsfw ?? stored.nsfw,
      moderatorNsfwLevel:
        'moderatorNsfwLevel' in data ? data.moderatorNsfwLevel : stored.moderatorNsfwLevel,
    };
  };
  const servedLevel = (row: Row) => bountyNsfwFlagLevel({ ...row, nsfwLevel: 60 }, undefined);

  it('raises a rating below R to R when the edit sets the flag', async () => {
    for (const rated of [NsfwLevel.PG, NsfwLevel.PG13]) {
      const stored = { nsfw: false, moderatorNsfwLevel: rated };
      mockStored(stored);
      await updateBountyById(modEdit as never);
      expect(updateData()).toMatchObject({
        moderatorNsfwLevel: NsfwLevel.R,
        moderatorNsfwLevelBasis: null,
      });
      expect(servedLevel(applied(stored))).toBe(NsfwLevel.R);
    }
  });

  it('keeps a rating made after the flag, and one at R or above', async () => {
    const cases = [
      { nsfw: true, moderatorNsfwLevel: NsfwLevel.PG13 },
      { nsfw: false, moderatorNsfwLevel: NsfwLevel.X },
    ];
    for (const stored of cases) {
      mockStored(stored);
      await updateBountyById(modEdit as never);
      expect(updateData()).not.toHaveProperty('moderatorNsfwLevel');
      expect(servedLevel(applied(stored))).toBe(stored.moderatorNsfwLevel);
    }
  });
});

// An unflagged bounty is served at its stored level, which updateBountyNsfwLevels' SQL computes.
// Here the edit's own write, its raw queries and its job enqueue all land on real tables.
describe('on real rows: the stored level after the nsfw flag moves', () => {
  type Row = { nsfw: boolean; moderatorNsfwLevel: number | null; nsfwLevel: number };
  const pg = { db: null as unknown as PGlite };
  const onPg = (query: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
    const q = 'text' in query ? query : Prisma.sql(query, ...(values as never[]));
    return pg.db.query(q.text, q.values as unknown[]);
  };
  const readRow = async () =>
    (
      await pg.db.query<Row>(
        `SELECT nsfw, "moderatorNsfwLevel", "nsfwLevel" FROM "Bounty" WHERE id = $1`,
        [BOUNTY_ID]
      )
    ).rows[0];
  const queued = async () =>
    (
      await pg.db.query(
        `SELECT 1 FROM "JobQueue" WHERE "entityId" = $1 AND "entityType" = 'Bounty' AND type = 'UpdateNsfwLevel'`,
        [BOUNTY_ID]
      )
    ).rows.length;
  const edit = async (nsfw: boolean) => {
    mockStored(await readRow());
    await updateBountyById({ ...baseUpdate, nsfw } as never);
  };

  beforeAll(async () => {
    pg.db = new PGlite();
    await pg.db.exec(`
      CREATE TYPE "EntityType" AS ENUM ('Bounty');
      CREATE TYPE "JobQueueType" AS ENUM ('UpdateNsfwLevel');
      CREATE TABLE "JobQueue" (
        "entityId" integer, "entityType" "EntityType", "type" "JobQueueType",
        PRIMARY KEY ("entityType", "entityId", "type")
      );
      CREATE TABLE "Bounty" (
        "id" integer PRIMARY KEY,
        "nsfw" boolean NOT NULL DEFAULT false,
        "nsfwLevel" integer NOT NULL DEFAULT 0,
        "moderatorNsfwLevel" integer,
        "description" text
      );
      CREATE TABLE "Image" ("id" integer PRIMARY KEY, "nsfwLevel" integer NOT NULL);
      CREATE TABLE "ImageConnection" ("imageId" integer, "entityType" text, "entityId" integer);
      CREATE TABLE "EntityModeration" (
        "entityType" text, "entityId" integer, "nsfwLevel" integer, "result" jsonb,
        "blocked" boolean NOT NULL DEFAULT false, "triggeredLabels" text[] NOT NULL DEFAULT '{}'
      );
      INSERT INTO "Image" VALUES (10, ${NsfwLevel.PG});
      INSERT INTO "ImageConnection" VALUES (10, 'Bounty', ${BOUNTY_ID});
      INSERT INTO "EntityModeration" ("entityType", "entityId", "nsfwLevel", "result")
        VALUES ('Bounty', ${BOUNTY_ID}, ${NsfwLevel.PG}, '{"version":"1"}');
    `);
  }, 60_000);
  afterAll(() => pg.db?.close());

  const saved = {
    queryRaw: mockDbWrite.$queryRaw.getMockImplementation(),
    executeRaw: mockDbWrite.$executeRaw.getMockImplementation(),
  };
  beforeEach(() => {
    mockDbWrite.$queryRaw.mockImplementation(((...a: Parameters<typeof onPg>) =>
      onPg(...a).then((r) => r.rows)) as never);
    mockDbWrite.$executeRaw.mockImplementation(((...a: Parameters<typeof onPg>) =>
      onPg(...a).then((r) => r.affectedRows ?? 0)) as never);
    // The edit's row write, reduced to the columns the stored level depends on.
    mockDbWrite.bounty.update.mockImplementation((async ({ data }: { data: Partial<Row> }) => {
      if (data.nsfw !== undefined)
        await pg.db.query(`UPDATE "Bounty" SET nsfw = $2 WHERE id = $1`, [BOUNTY_ID, data.nsfw]);
      if (data.moderatorNsfwLevel !== undefined)
        await pg.db.query(`UPDATE "Bounty" SET "moderatorNsfwLevel" = $2 WHERE id = $1`, [
          BOUNTY_ID,
          data.moderatorNsfwLevel,
        ]);
      return { id: BOUNTY_ID, userId: OWNER_ID };
    }) as never);
  });
  afterEach(() => {
    // A once-implementation left unconsumed by a failing test would read a closed PGlite later.
    vi.mocked(SearchIndexUpdate.queueUpdate).mockReset();
    mockDbWrite.bounty.findUnique.mockReset();
    mockDbWrite.$queryRaw.mockImplementation(saved.queryRaw as never);
    mockDbWrite.$executeRaw.mockImplementation(saved.executeRaw as never);
  });

  it('stores R or above as soon as the owner turns the flag on over a PG-13 rating, and after turning it off', async () => {
    // Scan rated PG, moderator rated PG-13.
    await pg.db.exec(`
      DELETE FROM "Bounty"; DELETE FROM "JobQueue";
      INSERT INTO "Bounty" VALUES (${BOUNTY_ID}, false, ${NsfwLevel.PG13}, ${NsfwLevel.PG13});
    `);

    await edit(true);
    expect(ratedLevel((await readRow()).nsfwLevel)).toBeGreaterThanOrEqual(NsfwLevel.R);
    expect(await queued()).toBe(1);

    await edit(false);
    const row = await readRow();
    expect(row.nsfw).toBe(false);
    expect(ratedLevel(row.nsfwLevel)).toBeGreaterThanOrEqual(NsfwLevel.R);
  });

  it('keeps the committed edit and its queued retry when the recompute fails', async () => {
    await pg.db.exec(`
      DELETE FROM "Bounty"; DELETE FROM "JobQueue";
      INSERT INTO "Bounty" VALUES (${BOUNTY_ID}, false, ${NsfwLevel.PG}, null);
    `);
    mockDbWrite.$queryRaw.mockImplementation(((...a: Parameters<typeof onPg>) => {
      const q = 'text' in a[0] ? a[0] : Prisma.sql(a[0], ...(a.slice(1) as never[]));
      if (q.text.includes('WITH next AS')) return Promise.reject(new Error('recompute failed'));
      return onPg(...a).then((r) => r.rows);
    }) as never);

    await edit(true);
    expect((await readRow()).nsfw).toBe(true);
    expect(await queued()).toBe(1);
  });

  // The blurb fan-out reads the row once unlocked, then again under the row lock; `between` runs
  // after the first read, where a concurrent write would land.
  const blurbEdit = async (between?: () => Promise<unknown>) => {
    let reads = 0;
    mockDbWrite.bounty.findUnique.mockImplementation((async () => {
      const row = { ...(await readRow()), name: 'A bounty', lockedProperties: [], details: null };
      if (++reads === 1) await between?.();
      return row;
    }) as never);
    mockEvaluateContent.mockReturnValue({
      shouldMarkNSFW: true,
      matchedWords: ['x'],
      reason: 'r',
      metrics: { matchCount: 1 },
    });
    await applyBountyContentChange({ id: BOUNTY_ID, description: 'blurb text' });
  };
  const seedPg13 = () =>
    pg.db.exec(`
      DELETE FROM "Bounty"; DELETE FROM "JobQueue";
      INSERT INTO "Bounty" VALUES (${BOUNTY_ID}, false, ${NsfwLevel.PG13}, ${NsfwLevel.PG13});
    `);

  it('reindexes at R or above when a blurb edit trips the profanity gate over a PG-13 rating', async () => {
    await seedPg13();
    let indexedLevel: number | undefined;
    vi.mocked(SearchIndexUpdate.queueUpdate).mockImplementationOnce((async () => {
      indexedLevel = (await readRow()).nsfwLevel;
    }) as never);

    await blurbEdit();

    expect(ratedLevel(indexedLevel ?? 0)).toBeGreaterThanOrEqual(NsfwLevel.R);
    expect(await queued()).toBe(1);
  });

  it('keeps a moderator rating written after the unlocked read', async () => {
    await seedPg13();

    await blurbEdit(() =>
      pg.db.query(`UPDATE "Bounty" SET "moderatorNsfwLevel" = $2 WHERE id = $1`, [
        BOUNTY_ID,
        NsfwLevel.X,
      ])
    );

    const row = await readRow();
    expect(row.moderatorNsfwLevel).toBe(NsfwLevel.X);
    expect(ratedLevel(row.nsfwLevel)).toBe(NsfwLevel.X);
    expect(row.nsfw).toBe(true);
    // One connection here, so the lock cannot block; check the second read is taken under it.
    const lockAt = mockDbWrite.$queryRaw.mock.calls.findIndex(([q]) =>
      (Array.isArray(q) ? q.join('') : (q as { text: string }).text).includes('FOR UPDATE')
    );
    expect(lockAt, 'row lock statement issued').toBeGreaterThanOrEqual(0);
    expect(
      mockDbWrite.$queryRaw.mock.invocationCallOrder[lockAt],
      'row lock taken before the locked re-read'
    ).toBeLessThan(mockDbWrite.bounty.findUnique.mock.invocationCallOrder[1]);
  });
});

describe('upsertBounty — images the edit form was not shown', () => {
  const upsert = (input: Record<string, unknown>) =>
    upsertBounty({
      isModerator: false,
      ...baseUpdate,
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      ...input,
    } as never);

  it('passes the ids the form was shown through to the image links', async () => {
    await upsert({
      images: [{ id: 1, url: '00000000-0000-4000-8000-000000000000' }],
      shownImageIds: [1, 2],
    });
    expect(vi.mocked(updateEntityImages).mock.calls[0][0]).toMatchObject({
      shownImageIds: [1, 2],
    });
  });

  // Every image hidden by the domain's cap: the form shows none and must still save a name edit.
  it('saves an edit whose form was shown no image', async () => {
    await upsert({ name: 'Renamed', images: [], shownImageIds: [] });
    expect(vi.mocked(updateEntityImages).mock.calls[0][0]).toMatchObject({ images: [] });
  });
});

describe('upsertBounty — profanity filter vs stored locks', () => {
  // upsertBounty re-parses through updateBountyInputSchema, which requires at least one
  // image and an expiry in the future.
  const upsert = (input: Record<string, unknown>) =>
    upsertBounty({
      isModerator: false,
      ...baseUpdate,
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      images: [{ url: '00000000-0000-4000-8000-000000000000' }],
      ...input,
    } as never);

  beforeEach(() => {
    mockEvaluateContent.mockReturnValue({
      shouldMarkNSFW: true,
      matchedWords: ['bad'],
      reason: 'threshold',
      metrics: {},
    });
  });

  it('refuses an update whose expiration precedes its start date', async () => {
    const day = 24 * 60 * 60 * 1000;
    await expect(
      upsert({
        startsAt: new Date(Date.now() + 10 * day).toISOString(),
        expiresAt: new Date(Date.now() + 2 * day).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('does not run once Bounty text scan is active for this bounty', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('active');

    await upsert({ nsfw: false });

    const data = updateData();
    expect(data.nsfw).toBe(false);
    expect(data).not.toHaveProperty('lockedProperties');
    expect(data.details ?? {}).not.toHaveProperty('profanityMatches');
    expect(getTextScanMode).toHaveBeenCalledWith('Bounty', BOUNTY_ID);
  });

  it('marks the bounty nsfw and locks nsfw when nothing is locked yet', async () => {
    await upsert({});

    const data = updateData();
    expect(data.nsfw).toBe(true);
    expect(data.lockedProperties).toEqual(['nsfw']);
  });

  it('keeps the stored locks when adding its nsfw lock', async () => {
    mockStored({ lockedProperties: ['poi'] });

    await upsert({});

    expect(updateData().lockedProperties).toEqual(['poi', 'nsfw']);
  });

  it('records the detection but does not override a DB-locked nsfw', async () => {
    mockStored({ lockedProperties: ['nsfw'] });

    await upsert({ nsfw: false });

    const data = updateData();
    expect(data).not.toHaveProperty('nsfw');
    expect(data).not.toHaveProperty('lockedProperties');
    expect(data.details).toEqual(expect.objectContaining({ profanityMatches: ['bad'] }));
  });

  describe("the text scan's record on an edit", () => {
    const scan = { workflowId: 'w', level: 4, at: '2026-11-16' };
    beforeEach(() => mockEvaluateContent.mockReturnValue({ shouldMarkNSFW: false }));

    it('keeps the stored record over one the editor sends', async () => {
      mockStored({ details: { baseModel: 'SD 1.5', textScanNsfw: scan } });
      for (const isModerator of [false, true]) {
        await upsert({
          isModerator,
          details: { baseModel: 'SDXL 1.0', textScanNsfw: { level: 1 } },
        });
        expect(updateData().details).toEqual({ baseModel: 'SDXL 1.0', textScanNsfw: scan });
      }
    });

    it('keeps it when the edit drops it or sends no details', async () => {
      mockStored({ details: { baseModel: 'SD 1.5', textScanNsfw: scan } });
      await upsert({ details: { baseModel: 'SDXL 1.0' } });
      expect(updateData().details).toEqual({ baseModel: 'SDXL 1.0', textScanNsfw: scan });
      await upsert({ details: undefined });
      expect(updateData().details).toEqual({ textScanNsfw: scan });
    });

    it("goes with a moderator's unflag, so a later manual flag is not read as the scan's", async () => {
      mockStored({ details: { baseModel: 'SD 1.5', textScanNsfw: scan } });
      await upsert({
        isModerator: true,
        nsfw: false,
        details: { baseModel: 'SD 1.5', textScanNsfw: scan },
      });
      const unflagged = updateData().details;
      expect(unflagged).toEqual({ baseModel: 'SD 1.5' });

      mockStored({ details: unflagged });
      await upsert({ isModerator: true, nsfw: true, details: unflagged });
      const reflagged = updateData().details;

      dbMock.dbRead.bounty.findUnique.mockResolvedValue({
        userId: 3,
        nsfw: true,
        details: reflagged,
        nsfwLevel: 60,
        updatedAt: new Date(),
        name: 'b',
        moderatorNsfwLevel: null,
        moderatorNsfwLevelBasis: null,
      });
      dbMock.dbRead.entityModeration.findUnique.mockResolvedValue({
        status: 'Succeeded',
        nsfwLevel: 4,
        result: { version: 1, textHash: 'h', labels: { nsfw: { level: 'r', reason: 'x' } } },
      });
      expect(await loadRatingReviewSubject('Bounty', 1)).toMatchObject({ currentLevel: 16 });
    });

    it("is kept when an owner's edit unflags", async () => {
      mockStored({ details: { baseModel: 'SD 1.5', textScanNsfw: scan } });
      await upsert({ nsfw: false, details: { baseModel: 'SD 1.5' } });
      expect(updateData().details).toEqual({ baseModel: 'SD 1.5', textScanNsfw: scan });
    });

    it('takes none from an editor when the scan wrote none', async () => {
      mockStored({ details: { baseModel: 'SD 1.5' } });
      await upsert({ details: { baseModel: 'SDXL 1.0', textScanNsfw: scan } });
      expect(updateData().details).toEqual({ baseModel: 'SDXL 1.0' });
    });
  });

  describe('the stored detection on an edit', () => {
    const storedDetails = {
      baseModel: 'SD 1.5',
      profanityMatches: ['term'],
      profanityEvaluation: { reason: 'test reason', correctedAt: '2026-01-01' },
    };
    beforeEach(() => {
      mockStored({ details: storedDetails });
      mockEvaluateContent.mockReturnValue({ shouldMarkNSFW: false });
    });

    it("keeps it over the owner's details, and ignores a pair the owner sends", async () => {
      await upsert({ details: { baseModel: 'SDXL 1.0', profanityMatches: ['other'] } });

      expect(updateData().details).toEqual({
        baseModel: 'SDXL 1.0',
        profanityMatches: ['term'],
        profanityEvaluation: { reason: 'test reason', correctedAt: '2026-01-01' },
      });
    });

    it('keeps it when the edit sends no details', async () => {
      await upsert({ details: undefined });

      expect(updateData().details).toEqual({
        profanityMatches: ['term'],
        profanityEvaluation: { reason: 'test reason', correctedAt: '2026-01-01' },
      });
    });

    it('writes a moderator edit as sent, which can clear it', async () => {
      await upsert({ isModerator: true, details: { baseModel: 'SDXL 1.0' } });

      expect(updateData().details).toEqual({ baseModel: 'SDXL 1.0' });
    });

    it('replaces it with a fresh detection', async () => {
      mockEvaluateContent.mockReturnValue({
        shouldMarkNSFW: true,
        matchedWords: ['new'],
        reason: 'fresh',
        metrics: {},
      });

      await upsert({ details: { baseModel: 'SD 1.5' } });

      expect(updateData().details).toEqual({
        baseModel: 'SD 1.5',
        profanityMatches: ['new'],
        profanityEvaluation: { reason: 'fresh', metrics: {} },
      });
    });
  });

  it('does not run for a moderator', async () => {
    await upsert({ isModerator: true, nsfw: false });

    const data = updateData();
    expect(data.nsfw).toBe(false);
    expect(data).not.toHaveProperty('lockedProperties');
  });

  it('stores the edited dates as their UTC day, hour dropped', async () => {
    await upsert({
      startsAt: '2030-03-04T13:00:00.000Z',
      expiresAt: '2030-03-20T17:00:00.000Z',
    });

    expect(updateData().startsAt).toEqual(new Date('2030-03-04T00:00:00.000Z'));
    expect(updateData().expiresAt).toEqual(new Date('2030-03-20T00:00:00.000Z'));
  });
});

describe('upsertBounty — create path', () => {
  // No `id`, so upsertBounty takes the create branch. createBountyInputSchema is stricter than
  // the update one, hence the full payload.
  const create = (input: Record<string, unknown> = {}) =>
    upsertBounty({
      isModerator: false,
      userId: OWNER_ID,
      name: 'A bounty',
      description: 'Some description',
      type: 'ModelCreation',
      mode: 'Individual',
      entryMode: 'BenefactorsOnly',
      currency: 'BUZZ',
      unitAmount: constants.bounties.minCreateAmount,
      minBenefactorUnitAmount: 1,
      details: {},
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      images: [{ url: '00000000-0000-4000-8000-000000000000' }],
      ...input,
    } as never);

  const chargedAccountTypes = () =>
    mockBuzzTransaction.mock.calls.at(-1)?.[0]?.fromAccountTypes ?? [];

  it('refuses a new bounty with no image', async () => {
    await expect(create({ images: [] })).rejects.toThrow(/At least one example image/);
    expect(mockDbWrite.bounty.create).not.toHaveBeenCalled();
  });

  it('checks the image upload keys before opening the transaction', async () => {
    await create();

    expect(checkEntityImageKeys).toHaveBeenCalledWith({
      images: [{ url: '00000000-0000-4000-8000-000000000000', type: 'image' }],
      userId: OWNER_ID,
    });
    expect(vi.mocked(checkEntityImageKeys).mock.invocationCallOrder[0]).toBeLessThan(
      mockDbWrite.$transaction.mock.invocationCallOrder[0]
    );
    expect(vi.mocked(createEntityImages).mock.calls[0][0]).toMatchObject({
      keysCheckedFor: CHECKED_URLS,
    });
  });

  it('charges green buzz when the caller asked for green', async () => {
    await create({ buzzType: 'green' });

    expect(chargedAccountTypes()).toEqual(['green']);
  });

  it('locks nsfw on a green-buzz bounty so it can never be flipped later', async () => {
    await create({ buzzType: 'green' });

    expect(createData().lockedProperties).toEqual(['nsfw']);
  });

  it('rejects a past start date as a bad request, not a server error', async () => {
    await expect(
      create({ startsAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Start date must be in the future' });
    expect(mockBuzzTransaction).not.toHaveBeenCalled();
  });

  it('stores the picked date as that UTC day, hour dropped', async () => {
    const day = 24 * 60 * 60 * 1000;
    const startDay = new Date(Math.floor((Date.now() + 3 * day) / day) * day);
    const expiryDay = new Date(startDay.getTime() + 10 * day);

    await create({
      startsAt: new Date(startDay.getTime() + 17 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(expiryDay.getTime() + 23 * 60 * 60 * 1000).toISOString(),
    });

    expect(createData().startsAt).toEqual(startDay);
    expect(createData().expiresAt).toEqual(expiryDay);
  });

  it('refuses an expiration before the start date, which the field bounds alone allow', async () => {
    const day = 24 * 60 * 60 * 1000;
    await expect(
      create({
        startsAt: new Date(Date.now() + 10 * day).toISOString(),
        expiresAt: new Date(Date.now() + 2 * day).toISOString(),
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Expiration date must come after the start date',
    });
    expect(mockBuzzTransaction).not.toHaveBeenCalled();
  });

  it('judges the start date against the current day, not the day the module loaded', async () => {
    const loadedAt = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(loadedAt + 5 * 24 * 60 * 60 * 1000);
      await expect(
        create({ startsAt: new Date(loadedAt + 2 * 24 * 60 * 60 * 1000).toISOString() })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to create an nsfw bounty paid in green buzz', async () => {
    await expect(create({ buzzType: 'green', nsfw: true })).rejects.toThrow(/Green Buzz/);
    expect(mockBuzzTransaction).not.toHaveBeenCalled();
  });

  it('charges yellow buzz and leaves nsfw unlocked otherwise', async () => {
    await create({ buzzType: 'yellow' });

    expect(chargedAccountTypes()).toEqual(['yellow']);
    expect(createData().lockedProperties).toBeUndefined();
  });

  it("takes no text scan record from the creator's details", async () => {
    await create({
      buzzType: 'yellow',
      details: { baseModel: 'SDXL 1.0', textScanNsfw: { level: 4 } },
    });
    expect(createData().details).toEqual({ baseModel: 'SDXL 1.0' });
  });

  it('carries the profanity filter nsfw lock into the new row', async () => {
    mockEvaluateContent.mockReturnValue({
      shouldMarkNSFW: true,
      matchedWords: ['bad'],
      reason: 'threshold',
      metrics: {},
    });

    await create({ buzzType: 'yellow' });

    const data = createData();
    expect(data.nsfw).toBe(true);
    expect(data.lockedProperties).toEqual(['nsfw']);
  });
});

describe('updateBountyById — poi', () => {
  it('refuses an owner turning poi on', async () => {
    await expect(updateBountyById({ ...baseUpdate, poi: true } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDbWrite.bounty.update).not.toHaveBeenCalled();
  });

  it('lets an owner re-save a bounty that is already poi', async () => {
    mockStored({ poi: true });
    await updateBountyById({ ...baseUpdate, poi: true } as never);
    expect(mockDbWrite.bounty.update).toHaveBeenCalled();
  });

  it('lets a moderator set poi', async () => {
    await updateBountyById({
      ...baseUpdate,
      userId: MODERATOR_ID,
      isModerator: true,
      poi: true,
    } as never);
    expect(updateData().poi).toBe(true);
  });
});

describe('updateBountyById — a moderator clearing a text-scan poi flag', () => {
  const flagged = {
    textScanFlags: {
      poi: {
        at: 'x',
        workflowId: 'wf-1',
        reason: 'r',
        textHash: 'h-flagged',
        prev: { availability: 'Unsearchable' },
      },
    },
  };
  const moderatorEdit = { ...baseUpdate, userId: MODERATOR_ID, isModerator: true, poi: false };

  it('restores the pre-flag availability and records a moderator ruling on the flagged text', async () => {
    mockStored({ poi: true, meta: flagged });
    await updateBountyById(moderatorEdit as never);

    const data = updateData();
    expect(data.availability).toBe('Unsearchable');
    expect(data.meta.textScanFlags.poi).toMatchObject({
      workflowId: 'wf-1',
      appealGranted: { by: MODERATOR_ID, textHash: 'h-flagged', via: 'moderator' },
    });
  });

  it('refuses, writing nothing, on a bounty a content wipe kept until its payout settles', async () => {
    mockStored({ poi: true, meta: { ...flagged, removedWithOwner: true } });
    await expect(updateBountyById(moderatorEdit as never)).rejects.toMatchObject({
      message: 'This bounty is kept hidden until its payout settles',
    });
    expect(mockDbWrite.bounty.update).not.toHaveBeenCalled();
  });

  it('touches neither availability nor meta for a poi the text scan did not set', async () => {
    mockStored({ poi: true, meta: null });
    await updateBountyById(moderatorEdit as never);
    const data = updateData();
    expect(data).not.toHaveProperty('availability');
    expect(data).not.toHaveProperty('meta');
  });
});

describe('addBenefactorUnitAmount — bounty schedule', () => {
  const hour = 60 * 60 * 1000;
  const support = (startsAt: Date) => {
    mockDbRead.bounty.findUnique.mockResolvedValue({
      id: BOUNTY_ID,
      complete: false,
      nsfw: false,
      nsfwLevel: 1,
      startsAt,
    });
    mockDbWrite.$queryRaw.mockResolvedValue([{ complete: false, refunded: false }]);
    mockDbWrite.bountyBenefactor.findUnique.mockResolvedValue({
      unitAmount: 100,
      currency: 'BUZZ',
      buzzTransactionId: [],
      awardedToId: null,
      awardedAt: null,
    });
    return addBenefactorUnitAmount({
      bountyId: BOUNTY_ID,
      unitAmount: 50,
      userId: OWNER_ID,
      buzzType: 'yellow',
    });
  };

  it('refuses added support, and spends no Buzz, before the bounty starts', async () => {
    await expect(support(new Date(Date.now() + 2 * hour))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockBuzzTransaction).not.toHaveBeenCalled();
    expect(mockDbWrite.bountyBenefactor.update).not.toHaveBeenCalled();
  });

  it('takes added support once the bounty has started', async () => {
    await support(new Date(Date.now() - hour));

    expect(mockBuzzTransaction).toHaveBeenCalledTimes(1);
  });
});
