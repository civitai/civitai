import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(async () => ({})),
}));
const OWNER_ID = 1;
// Claims from this moment are named; earlier ones are only counted.
const { VISIBLE_SINCE } = vi.hoisted(() => ({
  VISIBLE_SINCE: new Date('2026-11-01T00:00:00.000Z'),
}));
vi.mock('~/server/services/model-version-gift.constants', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  GIFT_CLAIMER_NAMES_VISIBLE_SINCE: VISIBLE_SINCE,
}));
const { decodeGiftClaimsCursor, giftClaimsSql, listGiftClaims } = await import(
  '~/server/services/model-version-gift.service'
);

/** Who claimed a gift link or batch, on the gift migration's own tables. */
const MIGRATIONS = [
  '20261229120000_model_version_gift_link',
  '20261231000100_model_version_gift_redemption_revoked',
].map((dir) =>
  path.resolve(
    __dirname,
    `../../../../packages/civitai-db-schema/prisma/migrations/${dir}/migration.sql`
  )
);

const BATCH = '00000000-0000-4000-8000-0000000000aa';
const OTHER_BATCH = '00000000-0000-4000-8000-0000000000bb';

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  // listGiftClaims reads through dbRead: back its raw queries with this database.
  dbMock.dbRead.$queryRaw.mockImplementation(
    async (sql: { text: string; values: unknown[] }) => (await db.query(sql.text, sql.values)).rows
  );
  dbMock.dbRead.modelVersion.findUnique.mockImplementation(
    async ({ where }: { where: { id: number } }) => ({
      id: where.id,
      status: 'Published',
      model: { id: 1, userId: OWNER_ID, status: 'Published' },
    })
  );
  await db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, username text);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY);
    INSERT INTO "ModelVersion" VALUES (100), (200);
  `);
  for (const file of MIGRATIONS) await db.exec(readFileSync(file, 'utf8'));
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`
    TRUNCATE "ModelVersionGiftLink" RESTART IDENTITY CASCADE;
    TRUNCATE "User" CASCADE;
    INSERT INTO "User" SELECT g, 'user' || g FROM generate_series(1, 20) g;
  `);
});

let hashes = 0;
async function link(versionId: number, batchId: string | null = null) {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO "ModelVersionGiftLink" ("modelVersionId", "createdById", "codeHash", "codeHint", "batchId", "maxRedemptions")
     VALUES ($1, 1, $2, 'abcd', $3, $4) RETURNING id`,
    [versionId, `h${hashes++}`, batchId, batchId ? 1 : null]
  );
  return rows[0].id;
}
const claim = (giftLinkId: number, userId: number, claimedAt: string) =>
  db.query(
    `INSERT INTO "ModelVersionGiftRedemption" ("giftLinkId", "userId", "claimedAt") VALUES ($1, $2, $3)`,
    [giftLinkId, userId, claimedAt]
  );

async function claimers(
  args: Omit<Parameters<typeof giftClaimsSql>[0], 'cursor' | 'visibleSince'>,
  cursor = null
) {
  const sql = giftClaimsSql({ ...args, cursor, visibleSince: VISIBLE_SINCE });
  return (
    await db.query<{ userId: number; username: string; revokedAt: Date | null }>(
      sql.text,
      sql.values
    )
  ).rows;
}

describe('gift claimers', () => {
  it("lists one link's claimers, newest first, and only that link's", async () => {
    const a = await link(100);
    const b = await link(100);
    await claim(a, 2, '2026-11-01T00:00:01.000');
    await claim(a, 3, '2026-11-01T00:00:02.000');
    await claim(b, 4, '2026-11-01T00:00:03.000');
    const rows = await claimers({ modelVersionId: 100, id: a, limit: 50 });
    expect(rows.map((r) => [r.userId, r.username])).toEqual([
      [3, 'user3'],
      [2, 'user2'],
    ]);
  });

  it("lists a batch's claimers across its codes, and no other batch's", async () => {
    const c1 = await link(100, BATCH);
    const c2 = await link(100, BATCH);
    const other = await link(100, OTHER_BATCH);
    await claim(c1, 5, '2026-11-01T00:00:01.000');
    await claim(c2, 6, '2026-11-01T00:00:02.000');
    await claim(other, 7, '2026-11-01T00:00:03.000');
    const rows = await claimers({ modelVersionId: 100, batchId: BATCH, limit: 50 });
    expect(rows.map((r) => r.userId)).toEqual([6, 5]);
  });

  it('lists a removed claim with when it was removed', async () => {
    const a = await link(100);
    await claim(a, 2, '2026-11-01T00:00:01.000');
    await claim(a, 3, '2026-11-01T00:00:02.000');
    await db.query(
      `UPDATE "ModelVersionGiftRedemption" SET "revokedAt" = '2026-11-02T00:00:00.000' WHERE "userId" = 2`
    );
    const rows = await claimers({ modelVersionId: 100, id: a, limit: 50 });
    expect(rows.map((r) => [r.userId, r.revokedAt])).toEqual([
      [3, null],
      [2, new Date('2026-11-02T00:00:00.000Z')],
    ]);
  });

  it('finds nothing for a gift asked for under another version', async () => {
    const a = await link(200);
    await claim(a, 2, '2026-11-01T00:00:01.000');
    expect(await claimers({ modelVersionId: 100, id: a, limit: 50 })).toEqual([]);
  });

  it("pages a batch's claimers through listGiftClaims, across codes claimed at the same time", async () => {
    const codes = [await link(100, BATCH), await link(100, BATCH), await link(100, BATCH)];
    // User 10 holds a code of each; ties on (claimedAt, userId) are broken by giftLinkId alone.
    for (const [i, code] of codes.entries()) {
      await claim(code, 10, '2026-11-03T00:00:00.000');
      await claim(code, 11 + i, '2026-11-03T00:00:00.000');
    }
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof listGiftClaims>> = await listGiftClaims({
        userId: OWNER_ID,
        modelVersionId: 100,
        batchId: BATCH,
        cursor,
        limit: 2,
      });
      expect(page.claims.length).toBeLessThanOrEqual(2);
      seen.push(...page.claims.map((c) => c.userId));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    // Six claimers in pages of two: the third page is an exact fit and has no next cursor.
    expect(pages).toBe(3);
    expect(seen.sort((a, b) => a - b)).toEqual([10, 10, 10, 11, 12, 13]);
  });

  it('finds nothing for a batch asked for under another version', async () => {
    const code = await link(200, BATCH);
    await claim(code, 2, '2026-11-01T00:00:01.000');
    expect(await claimers({ modelVersionId: 100, batchId: BATCH, limit: 50 })).toEqual([]);
  });

  it('names claimers from the visible-since moment on, and only counts the ones before it', async () => {
    const a = await link(100);
    await claim(a, 2, '2026-10-31T23:59:59.999');
    await claim(a, 3, '2026-11-01T00:00:00.000');
    const page = await listGiftClaims({ userId: OWNER_ID, modelVersionId: 100, id: a });
    expect(page.claims.map((c) => [c.userId, c.username])).toEqual([[3, 'user3']]);
    expect(page.hiddenCount).toBe(1);
  });

  it('counts hidden claims on the first page only', async () => {
    const a = await link(100);
    await claim(a, 2, '2026-10-31T00:00:00.000');
    for (let u = 3; u <= 5; u++) await claim(a, u, '2026-11-02T00:00:00.000');
    const ask = (cursor: string | null) =>
      listGiftClaims({ userId: OWNER_ID, modelVersionId: 100, id: a, cursor, limit: 2 });
    const first = await ask(null);
    expect(first.hiddenCount).toBe(1);
    const spy = vi.mocked(dbMock.dbRead.$queryRaw);
    spy.mockClear();
    const second = await ask(first.nextCursor);
    expect(second.hiddenCount).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('asks for exactly one of a link or a batch', async () => {
    const ask = (target: { id?: number; batchId?: string }) =>
      listGiftClaims({ userId: OWNER_ID, modelVersionId: 100, ...target });
    await expect(ask({ id: 1, batchId: BATCH })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(ask({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('caps a page at 100 claimers whatever limit is asked for', async () => {
    const a = await link(100);
    await db.query(`INSERT INTO "User" SELECT g, 'user' || g FROM generate_series(21, 140) g`);
    await db.query(
      `INSERT INTO "ModelVersionGiftRedemption" ("giftLinkId", "userId", "claimedAt")
       SELECT $1, g, '2026-11-04T00:00:00.000' FROM generate_series(21, 140) g`,
      [a]
    );
    const page = await listGiftClaims({
      userId: OWNER_ID,
      modelVersionId: 100,
      id: a,
      limit: 1000,
    });
    expect(page.claims).toHaveLength(100);
    expect(page.nextCursor).not.toBeNull();
  });

  it('rejects a cursor it did not issue', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    expect(() => decodeGiftClaimsCursor(b64('1|2|3'))).toThrow();
    // Each answers 400 (BAD_REQUEST), never a cast error; Feb 31 parses, rolling over to Mar 3.
    for (const at of ['2026-13-02T00:00:00.000Z', '2026-02-31T00:00:00.000Z'])
      expect(() => decodeGiftClaimsCursor(b64(`${at}|2|3`))).toThrow(
        expect.objectContaining({ code: 'BAD_REQUEST' })
      );
    expect(() => decodeGiftClaimsCursor(b64('2026-11-02T00:00:00.000Z|x|3'))).toThrow();
    expect(decodeGiftClaimsCursor(b64('2026-11-02T00:00:00.000Z|2|3'))).toEqual({
      claimedAt: '2026-11-02T00:00:00.000Z',
      giftLinkId: 2,
      userId: 3,
    });
  });
});
