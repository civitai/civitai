import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The two account-wide content wipes refuse a held account, and a hold that lands mid-wipe stops
 * every delete that destroys evidence. The hold query and the guarded deletes run as SQL against a
 * Postgres stand-in; `removeAllContent` and the delete-user-images endpoint are the real code.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { holder, indexes, session } = vi.hoisted(() => ({
  holder: {
    db: null as unknown as PGlite,
    /** Runs just before the first image delete: a hold landing mid-run. */
    beforeImages: null as (() => Promise<unknown>) | null,
  },
  indexes: { queueUpdate: vi.fn(async () => undefined) },
  session: {
    user: { id: 9, isModerator: true, bannedAt: null } as Record<string, unknown> | null,
  },
}));

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  modelsSearchIndex: indexes,
  imagesSearchIndex: indexes,
  imagesMetricsSearchIndex: indexes,
  articlesSearchIndex: indexes,
  collectionsSearchIndex: indexes,
  bountiesSearchIndex: indexes,
  usersSearchIndex: indexes,
}));
vi.mock('~/server/metrics', async (importOriginal) => {
  const m = { queueUpdate: vi.fn(async () => undefined) };
  return {
    ...((await importOriginal()) as Record<string, unknown>),
    userMetrics: m,
    articleMetrics: m,
  };
});
// The DELETE `deleteImages` issues, with its `onlyWhere`; storage and caches are not under test.
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteImages: vi.fn(
    async (ids: number[], _posts?: boolean, opts?: { onlyWhere?: Prisma.Sql }) => {
      if (!ids.length) return [];
      if (holder.beforeImages) {
        await holder.beforeImages();
        holder.beforeImages = null;
      }
      const where = opts?.onlyWhere ? Prisma.sql`AND (${opts.onlyWhere})` : Prisma.empty;
      const sql = Prisma.sql`DELETE FROM "Image" WHERE id = ANY(${ids}::int[]) ${where} RETURNING id`;
      return (await holder.db.query(sql.text, sql.values)).rows;
    }
  ),
}));
vi.mock('~/server/services/auction.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteBidsForModel: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/apps/user-storage-purge.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  purgeUserAppStorageForAccountWipe: vi.fn(async ({ targetUserId }: { targetUserId: number }) => ({
    userId: targetUserId,
    purgeBatchId: 'apg_test',
    results: [],
    failures: [],
    unmappedSchemas: [],
    schemasTruncated: false,
    totals: { appCount: 0, deletedRowCount: 0, deletedBytes: 0 },
  })),
}));
vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => ({ wipeAccount: async () => ({ namespaces: [], failures: [] }) }),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: async () => session,
}));

import { LegalHoldError } from '~/server/services/legal-hold.service';
import { removeAllContent } from '~/server/services/user.service';
import deleteUserImages from '~/pages/api/mod/delete-user-images';
import removeAllContentWebhook from '~/pages/api/mod/remove-all-content';

const CLEAN = 1;
const HELD = 2; // named on a pending report
const MARKED = 3; // held by the marker view
const BYSTANDER = 9;
const EVIDENCE = ['CommentV2', 'Comment', 'Article', 'Post', 'Model', 'ChatMessage', 'ChatMember'];

/** Runs just before the first guarded delete: a hold landing after the check. */
let beforeEvidence: (() => Promise<unknown>) | null = null;
let failLookups = false;
/** Replaces what the wipe's re-check after its evidence deletes reads back. */
let afterHeld: unknown = undefined;

const run = (sql: Prisma.Sql) => holder.db.query(sql.text, sql.values);
const asSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "needsReview" text, "blockedFor" text
    );
    ${EVIDENCE.map(
      (t) => `CREATE TABLE "${t}" (id serial PRIMARY KEY, "userId" int NOT NULL);`
    ).join('\n')}
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  beforeEvidence = null;
  holder.beforeImages = null;
  failLookups = false;
  afterHeld = undefined;
  session.user = { id: 9, isModerator: true, bannedAt: null };
  await holder.db.exec(`
    DROP VIEW IF EXISTS "EvidenceHeldUser";
    DROP TABLE IF EXISTS "EvidenceHold";
    TRUNCATE "CsamReport", "Image", ${EVIDENCE.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY;
    INSERT INTO "CsamReport" ("userId") VALUES (${HELD});
    INSERT INTO "Image" (id, "userId", "postId") VALUES
      (${CLEAN * 100}, ${CLEAN}, 1), (${CLEAN * 100 + 1}, ${CLEAN}, 1),
      (${HELD * 100}, ${HELD}, NULL), (${MARKED * 100}, ${MARKED}, NULL),
      (${BYSTANDER * 100}, ${BYSTANDER}, NULL);
    ${EVIDENCE.map(
      (t) =>
        `INSERT INTO "${t}" ("userId") VALUES (${CLEAN}), (${HELD}), (${MARKED}), (${BYSTANDER});`
    ).join('\n')}
  `);

  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    if (failLookups) throw new Error('connection reset');
    const sql = asSql(first, values);
    if (afterHeld !== undefined && sql.text.trimEnd().endsWith('AS held'))
      return [{ held: afterHeld }];
    return (await run(sql)).rows;
  }) as never);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = asSql(first, values);
    if (beforeEvidence && sql.text.includes('DELETE FROM "CommentV2"')) {
      await beforeEvidence();
      beforeEvidence = null;
    }
    return (await run(sql)).affectedRows ?? 0;
  }) as never);
  vi.mocked(dbMock.dbRead.image.findMany).mockImplementation(
    (async (args: { where: { userId: number } }) =>
      (
        await holder.db.query(`SELECT id, "postId" FROM "Image" WHERE "userId" = $1`, [
          args.where.userId,
        ])
      ).rows) as never
  );
});

async function createMarkerView() {
  await holder.db.exec(`
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL, "releasedAt" timestamp(3));
    CREATE VIEW "EvidenceHeldUser" AS
      SELECT "userId" FROM "EvidenceHold" WHERE "releasedAt" IS NULL GROUP BY "userId";
    INSERT INTO "EvidenceHold" VALUES (${MARKED}, NULL);
  `);
}

/** Rows left per table for `userId`, images included. */
async function remaining(userId: number) {
  const counts: Record<string, number> = {};
  for (const t of [...EVIDENCE, 'Image'])
    counts[t] = Number(
      (
        await holder.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${t}" WHERE "userId" = $1`,
          [userId]
        )
      ).rows[0].n
    );
  return counts;
}
const all = (n: number) => Object.fromEntries([...EVIDENCE, 'Image'].map((t) => [t, n]));
/** What the seed gives `userId`: one row per table, and two images for CLEAN. */
const seeded = (userId: number) => ({ ...all(1), Image: userId === CLEAN ? 2 : 1 });

describe('removeAllContent', () => {
  it('wipes an account no hold covers, and no one else’s', async () => {
    await removeAllContent({ id: CLEAN });

    expect(await remaining(CLEAN)).toEqual(all(0));
    expect(await remaining(BYSTANDER)).toEqual(all(1));
    expect(indexes.queueUpdate).toHaveBeenCalled();
  });

  it.each([
    ['named on a report', HELD, async () => undefined],
    ['held by the marker', MARKED, createMarkerView],
  ])('refuses an account %s before deleting anything', async (_, userId, setup) => {
    await setup();
    const before = await remaining(userId);

    await expect(removeAllContent({ id: userId })).rejects.toBeInstanceOf(LegalHoldError);

    expect(await remaining(userId)).toEqual(before);
    expect(dbMock.dbWrite.imageReaction.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses when the hold cannot be checked', async () => {
    failLookups = true;
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldError);
    expect(await remaining(CLEAN)).toEqual(seeded(CLEAN));
    expect(dbMock.dbWrite.imageReaction.deleteMany).not.toHaveBeenCalled();
  });

  // PGlite has one connection, so this lands the hold strictly between the check and the deletes; it
  // shows each delete re-reads the hold, not how they behave under true concurrency.
  it('keeps every piece of evidence when a hold lands mid-wipe, and says so', async () => {
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);

    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldError);

    expect(await remaining(CLEAN)).toEqual(seeded(CLEAN));
    // The low-impact rows before the evidence go; nothing is reindexed or purged elsewhere.
    expect(dbMock.dbWrite.imageReaction.deleteMany).toHaveBeenCalled();
    expect(indexes.queueUpdate).not.toHaveBeenCalled();
  });

  it('keeps evidence when the marker appears mid-wipe after a check that found none', async () => {
    beforeEvidence = () => holder.db.exec(`CREATE TABLE "EvidenceHold" ("userId" int NOT NULL)`);
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldError);
    expect(await remaining(CLEAN)).toEqual(seeded(CLEAN));
  });

  it('wipes an unheld account while the marker view exists', async () => {
    await createMarkerView();
    await removeAllContent({ id: CLEAN });
    expect(await remaining(CLEAN)).toEqual(all(0));
  });

  it('keeps evidence when a marker lands mid-wipe', async () => {
    await createMarkerView();
    beforeEvidence = () => holder.db.exec(`INSERT INTO "EvidenceHold" VALUES (${CLEAN}, NULL)`);
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldError);
    expect(await remaining(CLEAN)).toEqual(seeded(CLEAN));
  });

  it.each([
    [
      'an image put to review',
      `UPDATE "Image" SET "needsReview" = 'csam' WHERE id = ${CLEAN * 100}`,
    ],
    [
      'an image blocked with no sent report',
      `UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${CLEAN * 100}`,
    ],
    [
      'an image listed on a pending report',
      `INSERT INTO "CsamReport" (images) VALUES ('[{"id": ${CLEAN * 100}}]')`,
    ],
  ])('keeps evidence when %s lands mid-wipe', async (_, landing) => {
    beforeEvidence = () => holder.db.exec(landing);
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldError);
    expect(await remaining(CLEAN)).toEqual(seeded(CLEAN));
  });

  it('reports a hold when its re-check cannot be read', async () => {
    afterHeld = null;
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldError);
    expect(indexes.queueUpdate).not.toHaveBeenCalled();
  });
});

/** A Next API response that records what the handler sent. */
function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn(),
    status: (code: number) => {
      res.statusCode = code;
      return res;
    },
    json: (body: unknown) => {
      res.body = body;
      return res;
    },
  };
  return res;
}

describe('/api/mod/remove-all-content', () => {
  const call = async (userId: number) => {
    const res = fakeRes();
    await removeAllContentWebhook(
      {
        method: 'POST',
        query: { token: 'test-webhook-token', userId: String(userId) },
        headers: {},
        cookies: {},
      } as never,
      res as never
    );
    return res;
  };

  it('wipes an unheld account', async () => {
    expect((await call(CLEAN)).statusCode).toBe(200);
    expect(await remaining(CLEAN)).toEqual(all(0));
  });

  it('answers 403 with the hold refusal for a held account, deleting nothing', async () => {
    const res = await call(HELD);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Account under legal hold; contact Legal.' });
    expect(await remaining(HELD)).toEqual(seeded(HELD));
  });
});

describe('/api/mod/delete-user-images', () => {
  const call = async (userId: number) => {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      setHeader: vi.fn(),
      status: (code: number) => {
        res.statusCode = code;
        return res;
      },
      json: (body: unknown) => {
        res.body = body;
        return res;
      },
    };
    await deleteUserImages(
      { method: 'GET', query: { userId: String(userId) }, headers: {}, cookies: {} } as never,
      res as never
    );
    return res;
  };

  it('deletes an unheld account’s images', async () => {
    const res = await call(CLEAN);
    expect(res.statusCode).toBe(200);
    expect((await remaining(CLEAN)).Image).toBe(0);
    // The post that held them goes with them.
    expect((await remaining(CLEAN)).Post).toBe(0);
    expect((await remaining(BYSTANDER)).Image).toBe(1);
    expect((await remaining(BYSTANDER)).Post).toBe(1);
  });

  it('deletes an unheld account’s images while the marker view exists', async () => {
    await createMarkerView();
    expect((await call(CLEAN)).statusCode).toBe(200);
    expect((await remaining(CLEAN)).Image).toBe(0);
  });

  it('refuses a held account with the hold refusal, deleting nothing', async () => {
    const res = await call(HELD);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Account under legal hold; contact Legal.' });
    expect((await remaining(HELD)).Image).toBe(1);
  });

  it('keeps the images and posts when a hold lands mid-run', async () => {
    holder.beforeImages = () =>
      holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);
    const res = await call(CLEAN);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ deletedImages: 0, deletedPosts: 0 });
    expect((await remaining(CLEAN)).Image).toBe(2);
    expect((await remaining(CLEAN)).Post).toBe(1);
  });
});
