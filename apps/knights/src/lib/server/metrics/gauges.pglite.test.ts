import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { Registry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { ensureMonthPartition } from '../queue/queue.service';
import { cachedSnapshot, readGaugeSnapshot, registerGauges } from './gauges';

// Far from the real clock, so next month's partition is one only this file creates.
const NOW = new Date('2030-01-15T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

let pg: PGlite;
let db: Kysely<DB>;

async function item(
  fields: Partial<{
    status: string;
    minRank: string;
    source: string;
    createdAt: string;
    expiresAt: string | null;
    audience: string | null;
    appliedAt: string | null;
    applyAttempts: number;
  }>
) {
  const f = {
    status: 'Open',
    minRank: 'Knight',
    source: 'scan-sample',
    createdAt: minutesAgo(1),
    expiresAt: null,
    audience: null,
    appliedAt: null,
    applyAttempts: 0,
    ...fields,
  };
  await pg.query(
    `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded","status","createdAt","expiresAt","audience","appliedAt","applyAttempts")
     VALUES ('knights.image.nsfwLevel', (SELECT COALESCE(max("imageId"), 0) + 1 FROM "KnightsQueueItem"), $1, $2, 4, $3, $4, $5, $6, $7, $8)`,
    [
      f.source,
      f.minRank,
      f.status,
      f.createdAt,
      f.expiresAt,
      f.audience,
      f.appliedAt,
      f.applyAttempts,
    ]
  );
}

async function conversion(status: string, createdAt: string) {
  await pg.query(
    `INSERT INTO "KnightsGoldConversion" ("playerId","gold","buzz","status","externalTransactionId","createdAt")
     VALUES (1, 20, 1, $1, gen_random_uuid()::text, $2)`,
    [status, createdAt]
  );
}

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());

  await item({ minRank: 'Knight', createdAt: minutesAgo(10) });
  await item({ minRank: 'Knight', createdAt: minutesAgo(2), source: 'owner-rating' });
  await item({ minRank: 'Templar', createdAt: minutesAgo(5), expiresAt: minutesAgo(20) });
  await item({ minRank: 'Templar', createdAt: minutesAgo(4), expiresAt: minutesAgo(5) });
  await item({ audience: 'players', createdAt: minutesAgo(30), source: 'yesno-import' });
  await item({ status: 'Inquisitor', minRank: 'Inquisitor', source: 'dev-backfill' });
  await item({ status: 'Resolved', applyAttempts: 2 });
  await item({ status: 'Resolved', applyAttempts: 0 });
  await item({ status: 'Resolved', applyAttempts: 3, appliedAt: minutesAgo(1) });

  await conversion('failed', minutesAgo(60));
  await conversion('failed', minutesAgo(3 * 24 * 60));
  await conversion('pending', minutesAgo(20));
  await conversion('pending', minutesAgo(5));
  await conversion('paid', minutesAgo(60));

  await pg.query(
    `INSERT INTO "KnightsShopItem" ("id","kind","name","price","buzz") VALUES (1,'buzz_pack','Pack',20,1)`
  );
  for (const [key, status, at] of [
    ['a', 'pending', minutesAgo(20)],
    ['b', 'pending', minutesAgo(5)],
    ['c', 'granted', minutesAgo(60)],
  ]) {
    await pg.query(
      `INSERT INTO "KnightsShopPurchase" ("playerId","requestKey","externalKey","itemId","kind","gold","grant","status","createdAt")
       VALUES (1, $1, $1, 1, 'buzz_pack', 20, '{}', $2, $3)`,
      [key, status, at]
    );
  }

  for (const [imageId, pool, status] of [
    [1, 'trials', 'active'],
    [2, 'trials', 'active'],
    [3, 'trials', 'retired'],
    [4, 'hiddenCheck', 'active'],
  ]) {
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","status") VALUES ($1,$2,'4','core',$3)`,
      [imageId, pool, status]
    );
  }
  await pg.query(
    `INSERT INTO "KnightsHarvestCursor" ("name","updatedAt") VALUES ('mod-ratings', $1)`,
    [minutesAgo(90)]
  );
});
afterAll(() => pg.close());

describe('readGaugeSnapshot', () => {
  it('reads every gauge from the tables', async () => {
    const snapshot = await readGaugeSnapshot(db, NOW);

    expect(snapshot.open).toEqual({
      Knight: { count: 2, oldestAgeSeconds: 600 },
      Templar: { count: 2, oldestAgeSeconds: 300 },
      yesno: { count: 1, oldestAgeSeconds: 1800 },
    });
    expect(snapshot.newestAgeSeconds).toEqual({
      'scan-sample': 60,
      'owner-rating': 120,
      'yesno-import': 1800,
      other: 60,
    });
    expect(snapshot.overdue).toBe(1);
    expect(snapshot.inquisitor).toBe(1);
    expect(snapshot.writebackPending).toBe(1);
    expect(snapshot.buzzGrantsStuck).toEqual({ failed: 1, pending: 1 });
    expect(snapshot.shopPurchasesStuck).toBe(1);
    expect(snapshot.referencePool).toEqual({ trials: 2, hiddenCheck: 1 });
    expect(snapshot.harvestLastRun).toEqual(new Date(minutesAgo(90)));
    expect(snapshot.nextPartitionReady).toBe(false);
  });

  it("sees next month's vote partition once it exists", async () => {
    await ensureMonthPartition(db, { year: 2030, month: 2 });
    expect((await readGaugeSnapshot(db, NOW)).nextPartitionReady).toBe(true);
  });
});

describe('registerGauges', () => {
  it('exports the snapshot and knights_db_up 1', async () => {
    const register = new Registry();
    registerGauges(
      register,
      cachedSnapshot(() => readGaugeSnapshot(db, NOW))
    );

    const text = await register.metrics();

    expect(text).toContain('knights_db_up 1');
    expect(text).toContain('knights_queue_open_items{stage="Paladin"} 0');
    expect(text).toContain('knights_queue_oldest_open_age_seconds{stage="yesno"} 1800');
    expect(text).toContain('knights_buzz_grants_stuck{state="pending"} 1');
    expect(text).toContain('knights_reference_pool_items{pool="hiddenCheck"} 1');
    expect(text).toContain(
      `knights_harvest_last_run_timestamp_seconds ${new Date(minutesAgo(90)).getTime() / 1000}`
    );
  });

  it('reports knights_db_up 0 and no other value when the query fails, without throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const register = new Registry();
    registerGauges(
      register,
      cachedSnapshot(() => readGaugeSnapshot(db.withSchema('missing'), NOW))
    );

    const text = await register.metrics();

    expect(text).toContain('knights_db_up 0');
    expect(text).not.toMatch(/^knights_queue_open_items/m);
    expect(text).toMatch(/^knights_inquisitor_items nan$/im);
  });
});

describe('cachedSnapshot', () => {
  it('reads once per window, failures included', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let clock = 0;
    const read = vi.fn().mockRejectedValue(new Error('down'));
    const load = cachedSnapshot(read, { ttlMs: 60_000, clock: () => clock });

    expect(await load()).toBeNull();
    clock = 59_999;
    await load();
    expect(read).toHaveBeenCalledTimes(1);
    clock = 60_000;
    await load();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
