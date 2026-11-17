import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/paid-access.service', () => ({ getPaidAccess: vi.fn() }));
const { decodeGiftIndexCursor, giftIndexSql, toGiftIndexPage } = await import(
  '~/server/services/model-version-gift.service'
);

/** A creator's gift index across their versions, on the gift migration's own tables. */
const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261229120000_model_version_gift_link/migration.sql'
);

const OWNER = 1;
const OTHER = 2;
// OWNER owns model 10 (versions 100, 101) and model 11 (version 110); OTHER owns model 20 (version 200).
const SCHEMA = `
  CREATE TABLE "User" (id int PRIMARY KEY);
  CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL, name text NOT NULL);
  CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL, name text NOT NULL);
  INSERT INTO "User" VALUES (1), (2);
  INSERT INTO "Model" VALUES (10, 1, 'Alpha'), (11, 1, 'Beta'), (20, 2, 'Theirs');
  INSERT INTO "ModelVersion" VALUES (100, 10, 'v1'), (101, 10, 'v2'), (110, 11, 'b1'), (200, 20, 'x1');
`;

let db: PGlite;
let seq = 0;
let hashes = 0;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`TRUNCATE "ModelVersionGiftLink" RESTART IDENTITY CASCADE`);
  seq = 0;
});

/** Inserts link rows; each call is one second later than the last, so order is known. */
async function insert(
  versionId: number,
  rows: number,
  opts: {
    batchId?: string;
    createdAt?: string;
    maxRedemptions?: number | null;
    claimed?: number;
  } = {}
) {
  const at = opts.createdAt ?? `2026-11-01T00:00:${String(seq++).padStart(2, '0')}.000`;
  for (let i = 0; i < rows; i++) {
    await db.query(
      `INSERT INTO "ModelVersionGiftLink"
         ("modelVersionId", "createdById", "codeHash", "codeHint", "batchId", "maxRedemptions",
          "redemptionCount", "createdAt")
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
      [
        versionId,
        `h${hashes++}`,
        'abcd',
        opts.batchId ?? null,
        opts.batchId ? 1 : opts.maxRedemptions ?? null,
        i < (opts.claimed ?? 0) ? 1 : 0,
        at,
      ]
    );
  }
}

async function page(userId: number, limit: number, cursor: string | null = null) {
  const sql = giftIndexSql({
    userId,
    cursor: cursor ? decodeGiftIndexCursor(cursor) : null,
    limit,
  });
  const rows = (await db.query(sql.text, sql.values)).rows;
  return toGiftIndexPage(rows as never, limit);
}

const keyOf = (i: { kind: string } & Record<string, unknown>) =>
  i.kind === 'link' ? `link:${i.id}` : `batch:${i.batchId}`;

describe('the gift index', () => {
  it("lists the owner's links and batches across all their versions, and nobody else's", async () => {
    await insert(100, 1);
    await insert(101, 3, { batchId: '00000000-0000-4000-8000-000000000001', claimed: 1 });
    await insert(110, 1, { maxRedemptions: 5 });
    await insert(200, 1);
    await insert(200, 2, { batchId: '00000000-0000-4000-8000-000000000002' });

    const { items, nextCursor } = await page(OWNER, 50);
    expect(nextCursor).toBeNull();
    expect(items.map((i) => [i.kind, i.modelVersionId, i.modelName, i.versionName])).toEqual([
      ['link', 110, 'Beta', 'b1'],
      ['batch', 101, 'Alpha', 'v2'],
      ['link', 100, 'Alpha', 'v1'],
    ]);
    expect(items[1]).toMatchObject({ kind: 'batch', total: 3, claimed: 1, live: 2 });
    expect(items[0]).toMatchObject({ kind: 'link', maxRedemptions: 5, redemptionCount: 0 });

    const theirs = await page(OTHER, 50);
    expect(theirs.items.map((i) => i.modelVersionId)).toEqual([200, 200]);
  });

  it('pages through every item once, with ties on createdAt broken by key', async () => {
    const sameTime = '2026-11-02T00:00:00.000';
    for (let v = 0; v < 3; v++) await insert(100, 1, { createdAt: sameTime });
    await insert(101, 2, { batchId: '00000000-0000-4000-8000-00000000000a', createdAt: sameTime });
    for (let v = 0; v < 4; v++) await insert(110, 1);

    const all = (await page(OWNER, 50)).items.map(keyOf);
    expect(all).toHaveLength(8);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p = await page(OWNER, 3, cursor);
      seen.push(...p.items.map(keyOf));
      cursor = p.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(all);
  });

  it('rejects a cursor that is not one it issued', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    expect(() => decodeGiftIndexCursor('not-a-cursor')).toThrow();
    // Date.parse accepts these; the timestamp cast would not.
    expect(() => decodeGiftIndexCursor(b64('1|42'))).toThrow();
    expect(() => decodeGiftIndexCursor(b64('Nov 2026|42'))).toThrow();
    expect(() => decodeGiftIndexCursor(b64('2026-13-02T00:00:00.000Z|42'))).toThrow();
    expect(decodeGiftIndexCursor(b64('2026-11-02T00:00:00.000Z|42'))).toEqual({
      createdAt: '2026-11-02T00:00:00.000Z',
      key: '42',
    });
  });

  it("counts a batch's revoked and expired codes as no longer live", async () => {
    const batchId = '00000000-0000-4000-8000-0000000000bb';
    await insert(100, 4, { batchId });
    await db.query(
      `UPDATE "ModelVersionGiftLink" SET "revokedAt" = now() WHERE id = (SELECT min(id) FROM "ModelVersionGiftLink")`
    );
    await db.query(
      `UPDATE "ModelVersionGiftLink" SET "expiresAt" = now() - interval '1 day'
        WHERE id = (SELECT min(id) + 1 FROM "ModelVersionGiftLink")`
    );
    const [batch] = (await page(OWNER, 50)).items;
    expect(batch).toMatchObject({ kind: 'batch', total: 4, claimed: 0, live: 2 });
    expect(batch.expiresAt).not.toBeNull();
  });
});
