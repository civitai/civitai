import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const migrationSql = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

const db = { pg: null as unknown as PGlite };

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

beforeAll(async () => {
  db.pg = await PGlite.create();
  // Only the columns the migration reads.
  await db.pg.exec(`CREATE TABLE "EntityModeration" (
    "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INT NOT NULL,
    "result" JSONB, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now())`);
  await db.pg.exec(migrationSql('20261016150000_text_scan_hold'));
});
afterAll(async () => {
  await db.pg.close();
});
beforeEach(async () => {
  await db.pg.exec('TRUNCATE "TextScanHold", "EntityModeration" RESTART IDENTITY');
  await db.pg.exec(`DROP INDEX IF EXISTS "TextScanHold_one_pending_per_entity_key"`);
});

const hold = (hash: string, meta = '{}', entityId = 1, status = 'Pending', entityType = 'Post') =>
  db.pg.query(
    `INSERT INTO "TextScanHold" ("entityType","entityId","label","textHash","status","text","reason","meta","updatedAt")
     VALUES ($5, $1, 'csam', $2, $6::"TextScanHoldStatus", $3, 'r', $4::jsonb, now())`,
    [entityId, hash, `text ${hash}`, meta, entityType, status]
  );
const metaOf = async (id: number) =>
  (
    await db.pg.query<{ meta: Record<string, unknown> }>(
      `SELECT "meta" FROM "TextScanHold" WHERE "id" = $1`,
      [id]
    )
  ).rows[0].meta;
const scanned = (hash: string, entityType = 'Post', entityId = 1) =>
  db.pg.query(
    `INSERT INTO "EntityModeration" ("entityType","entityId","result") VALUES ($1, $2, $3::jsonb)`,
    [entityType, entityId, JSON.stringify({ textHash: hash })]
  );
const survivors = async () =>
  (
    await db.pg.query<{ id: number; textHash: string }>(
      `SELECT "id","textHash" FROM "TextScanHold" WHERE "status" = 'Pending' ORDER BY "id"`
    )
  ).rows;
const migrate = () => db.pg.exec(migrationSql('20261112120000_text_scan_hold_one_pending'));

describe('one pending hold migration', () => {
  it('keeps the newest pending hold when nothing says otherwise', async () => {
    await hold('a');
    await hold('b');
    await migrate();
    expect(await survivors()).toEqual([{ id: 2, textHash: 'b' }]);
  });

  it('keeps the hold whose text is the one last scanned, not just the newest', async () => {
    await hold('a');
    await hold('b');
    await scanned('a');
    await migrate();
    expect(await survivors()).toEqual([{ id: 1, textHash: 'a' }]);
  });

  it('reads the last scan from the shadow row too, newest row winning', async () => {
    await hold('a');
    await hold('b');
    await scanned('a');
    await scanned('b', 'Post:shadow');
    await migrate();
    expect(await survivors()).toEqual([{ id: 2, textHash: 'b' }]);
  });

  it('keeps the hold a moderator is mid-decision on, whatever its text', async () => {
    await hold('a', `{"decisionClaim":{"by":7,"at":"${new Date().toISOString()}"}}`);
    await hold('b');
    await scanned('b');
    await migrate();
    expect(await survivors()).toEqual([{ id: 1, textHash: 'a' }]);
  });

  it('does not protect a claim whose holder is long gone', async () => {
    await hold('a', `{"decisionClaim":{"by":7,"at":"2020-01-01T00:00:00.000Z"}}`);
    await hold('b');
    await migrate();
    expect(await survivors()).toEqual([{ id: 2, textHash: 'b' }]);
  });

  it('marks the others superseded, not decided by a person, and is safe to run twice', async () => {
    await hold('a');
    await hold('b');
    await migrate();
    await migrate();
    const { rows } = await db.pg.query(
      `SELECT "status","decidedById","meta" FROM "TextScanHold" WHERE "id" = 1`
    );
    expect(rows[0]).toMatchObject({
      status: 'Dismissed',
      decidedById: null,
      meta: { decision: 'superseded', supersededBy: 2 },
    });
  });

  describe('re-detection marker', () => {
    it('marks the survivor of duplicates as re-detected after the latest ruling', async () => {
      await hold('a', '{}', 1, 'Dismissed');
      await hold('b');
      await hold('c');
      await migrate();
      expect(await survivors()).toEqual([{ id: 3, textHash: 'c' }]);
      expect(await metaOf(3)).toMatchObject({ kind: 'redetected', priorHoldId: 1 });
    });

    it('marks a single pending hold that came after a ruling, keeping its other meta', async () => {
      await hold('a', '{}', 1, 'Confirmed');
      await hold('b', '{"contentAt":"2026-10-01"}');
      await migrate();
      expect(await metaOf(2)).toEqual({
        contentAt: '2026-10-01',
        kind: 'redetected',
        priorHoldId: 1,
      });
    });

    it('points at the latest ruling, and ignores holds the migration superseded', async () => {
      await hold('a', '{}', 1, 'Dismissed');
      await hold('b', '{}', 1, 'Dismissed');
      await hold('c', '{"decision":"superseded"}', 1, 'Dismissed');
      await hold('d');
      await migrate();
      expect(await metaOf(4)).toMatchObject({ kind: 'redetected', priorHoldId: 2 });
    });

    it('leaves a pending hold with no ruling before it, other entities and chat messages alone', async () => {
      await hold('a');
      await hold('b', '{}', 2, 'Dismissed');
      await hold('c', '{}', 3, 'Dismissed', 'ChatMessage');
      await hold('d', '{}', 3, 'Pending', 'ChatMessage');
      await hold('e', '{"decision":"superseded"}', 4, 'Dismissed');
      await hold('f', '{}', 4);
      await migrate();
      expect(await metaOf(1)).toEqual({});
      expect(await metaOf(4)).toEqual({});
      expect(await metaOf(6)).toEqual({});
    });

    it('does not overwrite a marker the application already wrote, and is safe to run twice', async () => {
      await hold('a', '{}', 1, 'Dismissed');
      await hold('b', '{}', 1, 'Dismissed');
      await hold('c', '{"kind":"redetected","priorHoldId":1}');
      await migrate();
      await migrate();
      expect(await metaOf(3)).toEqual({ kind: 'redetected', priorHoldId: 1 });
    });
  });
});
