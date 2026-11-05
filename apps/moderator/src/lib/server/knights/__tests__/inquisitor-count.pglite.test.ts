import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../../image-nsfw-level', () => ({ updateImageNsfwLevel: vi.fn() }));

const { countInquisitorQueue, getInquisitorQueue } = await import('../inquisitor.service');

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../../../packages/civitai-db-schema/prisma/migrations/20261210120000_knights_v2_tables/migration.sql'
);

const Q = 'knights.image.nsfwLevel';

let db: PGlite;

// The row as the Knights app leaves it when a vote escalates: no reason, no expiry, stage Inquisitor.
const insertItem = (id: number, imageId: number, status: string, questionKey = Q) =>
  db.query(
    `INSERT INTO "KnightsQueueItem" ("id","questionKey","imageId","source","minRank","votesNeeded","status")
     VALUES ($1,$2,$3,'scan-sample',$4,5,$5)`,
    [id, questionKey, imageId, status === 'Inquisitor' ? 'Inquisitor' : 'Knight', status]
  );

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(`CREATE TABLE "Image" (
    "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "name" TEXT, "type" TEXT NOT NULL DEFAULT 'image',
    "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT false,
    "ingestion" TEXT NOT NULL DEFAULT 'Scanned', "blockedFor" TEXT
  );`);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`DELETE FROM "KnightsQueueItem"; DELETE FROM "Image";`);
  await db.exec(
    `INSERT INTO "Image" ("id","url","nsfwLevel") VALUES (1,'k1',4), (2,'k2',16), (3,'k3',2)`
  );
  await db.query(
    `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('other.q','bool','Is it?','[]'::jsonb)
     ON CONFLICT DO NOTHING`
  );
});

describe('the Inquisitor queue as Knights leaves it', () => {
  it('lists an escalated item that carries no reason and no expiry', async () => {
    await insertItem(1, 1, 'Inquisitor');

    const queue = await getInquisitorQueue();

    expect(queue.map((i) => [i.id, i.reason])).toEqual([[1, null]]);
  });
});

describe('countInquisitorQueue', () => {
  it('counts exactly what the page lists', async () => {
    await insertItem(1, 1, 'Inquisitor');
    await insertItem(2, 2, 'Inquisitor');
    await insertItem(3, 3, 'Open');
    await insertItem(4, 3, 'Inquisitor', 'other.q');
    // The page's join drops an item whose image is gone, so the badge must too.
    await insertItem(5, 99, 'Inquisitor');

    expect(await countInquisitorQueue()).toBe(2);
    expect(await countInquisitorQueue()).toBe((await getInquisitorQueue()).length);
  });

  it('is zero when nothing waits', async () => {
    expect(await countInquisitorQueue()).toBe(0);
  });
});
