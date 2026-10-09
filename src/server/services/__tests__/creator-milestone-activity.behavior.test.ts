import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActivityWatermark,
  ActivityWatermarkStore,
} from '~/server/services/creator-milestone-activity.service';
import {
  announceFromFor,
  previewActivityGrants,
  runActivityGroup,
  definitionsFingerprint,
  watermarkKeyFor,
} from '~/server/services/creator-milestone-activity.service';
import type { MilestoneDetectorGroup } from '~/server/services/creator-milestone-detectors';
import {
  activityDetectorGroups,
  activityValuesSql,
  judgeVoteGroups,
  judgeVoteTotalsSql,
} from '~/server/services/creator-milestone-detectors';
import type { ActivityMeasure } from '~/server/services/creator-milestone-registry';
import {
  activityMeasureOf,
  creatorMilestoneRegistry,
  milestoneKeysFor,
} from '~/server/services/creator-milestone-registry';
import type { MilestoneGrant } from '~/server/services/creator-milestone-grant.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Runs the activity detectors and the grant runner unmodified against every CreatorMilestone
 * migration on an in-process Postgres, with the source tables cut down to the columns they read.
 */

const MIGRATIONS = join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations');

const holder = { db: null as unknown as PGlite };
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
    cancel: async () => undefined,
  }),
} as never;
const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

const CREATOR = 10;
const QUIET = 11;
const BANNED = 12;
const TESTER = 13;

const groups = activityDetectorGroups();
const groupFor = (key: string) => {
  const group = groups.find((g) => g.keys.includes(key));
  if (!group) throw new Error(`no group for ${key}`);
  return group;
};
const MODELS = groupFor('create:models-1');
const ARTICLES = groupFor('create:articles-1');
const DOWNLOADS = groupFor('reach:downloads-100');
const FOLLOWERS = groupFor('reach:followers-100');
const SHOP = groupFor('earn:shop-sales-100000');

const AFTER_LAUNCH = new Date('2026-11-01T00:00:00Z');

function memoryStore(initial: Record<string, ActivityWatermark> = {}) {
  const rows = new Map(Object.entries(initial));
  const store: ActivityWatermarkStore = {
    get: async (key) => rows.get(key) ?? null,
    set: async (key, watermark) => void rows.set(key, watermark),
  };
  return { store, rows };
}

async function fingerprintFor(group: MilestoneDetectorGroup) {
  const definitions = await q<{ key: string; threshold: number | null }>(
    `SELECT key, threshold FROM "CreatorMilestone" WHERE key = ANY($1::text[])`,
    [group.keys]
  );
  return definitionsFingerprint(definitions, group.silent);
}

type PreviousRun = Omit<ActivityWatermark, 'definitions'> & { definitions?: string };

async function run(
  group: MilestoneDetectorGroup,
  {
    watermark = null as PreviousRun | null,
    gated = false,
    audience = null as number[] | null,
    now = AFTER_LAUNCH,
    chunkSize = undefined as number | undefined,
  } = {}
) {
  const { store, rows } = memoryStore(
    watermark
      ? {
          [watermarkKeyFor(group)]: {
            definitions: await fingerprintFor(group),
            ...watermark,
          },
        }
      : {}
  );
  const notified: MilestoneGrant[] = [];
  const result = await runActivityGroup(group, {
    readPg: pg,
    writePg: pg,
    store,
    gated,
    now,
    audienceAmong: async (ids) => new Set(ids.filter((id) => !audience || audience.includes(id))),
    notify: async (grants) => void notified.push(...grants),
    chunkSize,
  });
  return { result, notified, rows };
}

const held = (userId: number) =>
  q<{ key: string; seen: boolean; at: string }>(
    `SELECT "milestoneKey" AS key, "seenAt" IS NOT NULL AS seen,
       to_char("achievedAt", 'YYYY-MM-DD HH24:MI') AS at
     FROM "UserCreatorMilestone" WHERE "userId" = $1 ORDER BY 1`,
    [userId]
  );

let purchaseSeq = 0;
async function addSales(
  sales: {
    cosmeticId?: number | null;
    shopItemId?: number;
    amount: number;
    at: string;
    refunded?: boolean;
    id?: string;
  }[]
) {
  for (const sale of sales)
    await q(
      `INSERT INTO "UserCosmeticShopPurchases"
        ("buzzTransactionId", "cosmeticId", "shopItemId", "unitAmount", "purchasedAt", refunded)
       VALUES ($1, $2, $3, $4, $5::timestamp, $6)`,
      [
        sale.id ?? `tx-${++purchaseSeq}`,
        sale.cosmeticId ?? null,
        sale.shopItemId ?? 0,
        sale.amount,
        sale.at,
        sale.refunded ?? false,
      ]
    );
}

async function addModels(userId: number, publishedAt: string[], status = 'Published') {
  for (const at of publishedAt)
    await q(
      `INSERT INTO "Model" ("userId", status, "publishedAt") VALUES ($1, $2, $3::timestamp)`,
      [userId, status, at]
    );
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb, "deletedAt" timestamp(3), "bannedAt" timestamp(3));
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY, name text, "createdById" int);
    CREATE TABLE "CosmeticShopItem" (id int PRIMARY KEY, "addedById" int);
    CREATE TABLE "UserCosmeticShopPurchases" (
      "buzzTransactionId" text PRIMARY KEY, "cosmeticId" int, "shopItemId" int NOT NULL,
      "unitAmount" int NOT NULL, "purchasedAt" timestamp(3) NOT NULL, refunded boolean NOT NULL
    );
    CREATE TABLE "UserCosmeticShopPurchaseCosmetic" (
      "buzzTransactionId" text NOT NULL, "cosmeticId" int NOT NULL, "unitAmount" int NOT NULL,
      PRIMARY KEY ("buzzTransactionId", "cosmeticId")
    );
    CREATE TABLE "UserCosmetic" (
      "userId" int NOT NULL, "cosmeticId" int NOT NULL, "claimKey" text NOT NULL DEFAULT 'claimed',
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
    CREATE TABLE "Model" (
      id serial PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL,
      availability text NOT NULL DEFAULT 'Public', mode text,
      "deletedAt" timestamp(3), "publishedAt" timestamp(3)
    );
    CREATE TABLE "Article" (
      id serial PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL,
      availability text NOT NULL DEFAULT 'Public', "publishedAt" timestamp(3)
    );
    CREATE TABLE "ModelMetric" (
      "modelId" int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL,
      availability text NOT NULL DEFAULT 'Public', "downloadCount" int NOT NULL DEFAULT 0
    );
    CREATE TABLE "UserMetric" (
      "userId" int NOT NULL, timeframe text NOT NULL,
      "followerCount" int NOT NULL DEFAULT 0, "reactionCount" int NOT NULL DEFAULT 0,
      PRIMARY KEY ("userId", timeframe)
    );
  `);
  const migrations = readdirSync(MIGRATIONS)
    .sort()
    .map((dir) => join(MIGRATIONS, dir, 'migration.sql'))
    .filter((file) => {
      try {
        return readFileSync(file, 'utf8').includes('"CreatorMilestone"');
      } catch {
        return false;
      }
    });
  for (const file of migrations) await holder.db.exec(readFileSync(file, 'utf8'));
});

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE "UserCosmetic", "UserCreatorMilestone", "User", "Model", "Article", "ModelMetric", "UserMetric",
      "CosmeticShopItem", "UserCosmeticShopPurchases", "UserCosmeticShopPurchaseCosmetic";
    DELETE FROM "Cosmetic";
  `);
  for (const id of [CREATOR, QUIET, TESTER]) await q(`INSERT INTO "User" (id) VALUES ($1)`, [id]);
  await q(`INSERT INTO "User" (id, "bannedAt") VALUES ($1, now())`, [BANNED]);
});

describe('published-count detector', () => {
  it('dates each milestone by the publish of the item that reached it, still-published items only', async () => {
    await addModels(CREATOR, [
      '2026-01-01 10:00',
      '2026-01-02 10:00',
      '2026-01-03 10:00',
      '2026-01-04 10:00',
      '2026-01-05 10:00',
    ]);
    await addModels(QUIET, ['2026-01-01 10:00', '2026-01-02 10:00'], 'Draft');
    await q(
      `INSERT INTO "Model" ("userId", status, "deletedAt", availability, mode, "publishedAt") VALUES
        ($1, 'Published', now(), 'Public', NULL, '2026-01-01'),
        ($1, 'Published', NULL, 'Private', NULL, '2026-01-01'),
        ($1, 'Published', NULL, 'Public', 'Archived', '2026-01-01')`,
      [QUIET]
    );
    await run(MODELS);
    expect(await held(CREATOR)).toEqual([
      { key: 'create:models-1', seen: true, at: '2026-01-01 10:00' },
      { key: 'create:models-5', seen: true, at: '2026-01-05 10:00' },
    ]);
    expect(await held(QUIET)).toEqual([]);
  });

  it('counts articles separately from models', async () => {
    await q(
      `INSERT INTO "Article" ("userId", status, "publishedAt") VALUES ($1, 'Published', '2026-02-01')`,
      [CREATOR]
    );
    await addModels(QUIET, ['2026-02-01']);
    await q(
      `INSERT INTO "Article" ("userId", status, availability, "publishedAt") VALUES
        ($1, 'Published', 'Private', '2026-02-01'),
        ($1, 'Published', 'Public', now() + interval '1 day')`,
      [TESTER]
    );
    await run(ARTICLES);
    expect((await held(CREATOR)).map((r) => r.key)).toEqual(['create:articles-1']);
    expect(await held(QUIET)).toEqual([]);
    expect(await held(TESTER)).toEqual([]);
  });
});

describe('download and user-metric detectors', () => {
  it('takes the best published, non-private model, and grants every threshold it passes', async () => {
    await q(
      `INSERT INTO "ModelMetric" ("modelId", "userId", status, availability, "downloadCount") VALUES
        (1, $1, 'Published', 'Public', 600),
        (4, $1, 'Published', 'Public', 500),
        (2, $1, 'Published', 'Private', 900000),
        (3, $2, 'Draft', 'Public', 900000)`,
      [CREATOR, QUIET]
    );
    await run(DOWNLOADS);
    // 600 + 500 would pass 1,000: the definition is one model's downloads, not the creator's total.
    expect((await held(CREATOR)).map((r) => r.key)).toEqual(['reach:downloads-100']);
    expect(await held(QUIET)).toEqual([]);
  });

  it('reads the AllTime row only, and never grants an excluded account', async () => {
    await q(
      `INSERT INTO "UserMetric" ("userId", timeframe, "followerCount") VALUES
        ($1, 'AllTime', 150), ($2, 'Day', 5000), ($3, 'AllTime', 5000)`,
      [CREATOR, QUIET, BANNED]
    );
    await run(FOLLOWERS);
    expect((await held(CREATOR)).map((r) => r.key)).toEqual(['reach:followers-100']);
    expect(await held(QUIET)).toEqual([]);
    expect(await held(BANNED)).toEqual([]);
  });
});

describe('shop revenue detector', () => {
  // Cosmetic 1 is CREATOR's, cosmetic 2 is an official one, shop item 50 is a pack QUIET built.
  beforeEach(async () => {
    await q(`INSERT INTO "Cosmetic" (id, "createdById") VALUES (1, $1), (2, NULL)`, [CREATOR]);
    await q(`INSERT INTO "CosmeticShopItem" (id, "addedById") VALUES (40, $1), (50, $2)`, [
      TESTER,
      QUIET,
    ]);
  });

  it('dates each threshold by the sale that carried the gross total across it', async () => {
    // Inserted newest first with ids running against time: transaction ids are not chronological.
    await addSales([
      { id: 'a', cosmeticId: 1, shopItemId: 40, amount: 1000, at: '2026-03-04 10:00' },
      { id: 'b', cosmeticId: 1, shopItemId: 40, amount: 200000, at: '2026-03-03 10:00' },
      { id: 'c', cosmeticId: 1, shopItemId: 40, amount: 40000, at: '2026-03-02 10:00' },
      { id: 'd', cosmeticId: 1, shopItemId: 40, amount: 60000, at: '2026-03-01 10:00' },
    ]);
    // One candidate per threshold: later sales above it must not compete to date the grant.
    const candidates = await q<{ milestoneKey: string; achievedAt: Date }>(
      `${SHOP.sql({ keys: '$1', users: '$2' })} ORDER BY "milestoneKey"`,
      [SHOP.keys, null]
    );
    expect(candidates.map((c) => c.milestoneKey)).toEqual([
      'earn:shop-sales-100000',
      'earn:shop-sales-250000',
    ]);
    await run(SHOP);
    expect(await held(CREATOR)).toEqual([
      { key: 'earn:shop-sales-100000', seen: true, at: '2026-03-02 10:00' },
      { key: 'earn:shop-sales-250000', seen: true, at: '2026-03-03 10:00' },
    ]);
  });

  it('credits a cosmetic to its creator, not the shop item lister, and a pack to its builder', async () => {
    await addSales([
      { cosmeticId: 1, shopItemId: 40, amount: 100000, at: '2026-03-01' },
      { cosmeticId: null, shopItemId: 50, amount: 100000, at: '2026-03-01' },
    ]);
    await run(SHOP);
    expect((await held(CREATOR)).map((r) => r.key)).toEqual(['earn:shop-sales-100000']);
    expect((await held(QUIET)).map((r) => r.key)).toEqual(['earn:shop-sales-100000']);
    expect(await held(TESTER)).toEqual([]);
  });

  // A pack built around official or other creators' cosmetics: each member is its creator's sale.
  it('splits a pack sale between its builder and the creators of the members inside it', async () => {
    await q(`INSERT INTO "Cosmetic" (id, "createdById") VALUES (4, $1)`, [QUIET]);
    await addSales([
      { id: 'pack', cosmeticId: null, shopItemId: 50, amount: 200000, at: '2026-03-01' },
    ]);
    await q(
      `INSERT INTO "UserCosmeticShopPurchaseCosmetic" ("buzzTransactionId", "cosmeticId", "unitAmount")
       VALUES ('pack', 1, 100000), ('pack', 2, 60000), ('pack', 4, 30000)`
    );
    await run(SHOP);
    const [creator] = await q(activityValuesSql, [CREATOR]);
    const [builder] = await q(activityValuesSql, [QUIET]);
    expect([creator.revenue, builder.revenue]).toEqual([100000, 40000]);
    expect((await held(CREATOR)).map((r) => r.key)).toEqual(['earn:shop-sales-100000']);
    expect(await held(QUIET)).toEqual([]);
  });

  // An official member is recorded at its full list price, which can exceed what the buyer paid.
  it("a pack never subtracts from its builder's other sales", async () => {
    await addSales([
      { id: 'cheap-pack', cosmeticId: null, shopItemId: 50, amount: 50000, at: '2026-03-02' },
      { id: 'own-sale', cosmeticId: 4, shopItemId: 40, amount: 100000, at: '2026-03-03' },
    ]);
    await q(`INSERT INTO "Cosmetic" (id, "createdById") VALUES (4, $1)`, [QUIET]);
    await q(
      `INSERT INTO "UserCosmeticShopPurchaseCosmetic" ("buzzTransactionId", "cosmeticId", "unitAmount")
       VALUES ('cheap-pack', 2, 60000)`
    );
    await run(SHOP);
    const [builder] = await q(activityValuesSql, [QUIET]);
    expect(builder.revenue).toBe(100000);
    expect((await held(QUIET)).map((r) => r.key)).toEqual(['earn:shop-sales-100000']);
  });

  it('leaves out refunded sales and official cosmetics', async () => {
    await addSales([
      { cosmeticId: 1, shopItemId: 40, amount: 99999, at: '2026-03-01' },
      { cosmeticId: 1, shopItemId: 40, amount: 50000, at: '2026-03-02', refunded: true },
      {
        id: 'refunded-pack',
        cosmeticId: null,
        shopItemId: 50,
        amount: 500000,
        at: '2026-03-02',
        refunded: true,
      },
      { cosmeticId: 2, shopItemId: 40, amount: 500000, at: '2026-03-02' },
    ]);
    // A refund leaves the pack's member rows in place.
    await q(
      `INSERT INTO "UserCosmeticShopPurchaseCosmetic" ("buzzTransactionId", "cosmeticId", "unitAmount")
       VALUES ('refunded-pack', 1, 1)`
    );
    await run(SHOP);
    expect(await held(CREATOR)).toEqual([]);
    expect(await held(TESTER)).toEqual([]);
    expect(await held(QUIET)).toEqual([]);
  });

  it('announces a crossing since the previous run, and not one before it', async () => {
    await addSales([
      { cosmeticId: 1, shopItemId: 40, amount: 100000, at: '2026-10-31 12:00' },
      { cosmeticId: null, shopItemId: 50, amount: 100000, at: '2026-10-30 12:00' },
    ]);
    const { notified } = await run(SHOP, {
      watermark: { at: new Date('2026-10-31T00:00:00Z').getTime(), gated: false },
    });
    expect(notified.map((g) => `${g.userId}:${g.milestoneKey}`)).toEqual([
      `${CREATOR}:earn:shop-sales-100000`,
    ]);
  });

  it('while gated, grants only the flag audience', async () => {
    await q(`INSERT INTO "Cosmetic" (id, "createdById") VALUES (3, $1)`, [TESTER]);
    await addSales([
      { cosmeticId: 1, shopItemId: 40, amount: 100000, at: '2026-10-31 12:00' },
      { cosmeticId: 3, shopItemId: 40, amount: 100000, at: '2026-10-31 12:00' },
    ]);
    const { result, notified } = await run(SHOP, {
      watermark: { at: new Date('2026-10-31T00:00:00Z').getTime(), gated: true },
      gated: true,
      audience: [TESTER],
    });
    expect(result).toMatchObject({ candidates: 2, audience: 1, granted: 1 });
    expect(await held(CREATOR)).toEqual([]);
    expect(notified.map((g) => g.userId)).toEqual([TESTER]);
  });

  // Dated by a real sale, so a gated run can still tell tonight's crossing from a backlog.
  it('announces a dated crossing even across gated runs', async () => {
    await addSales([{ cosmeticId: 1, shopItemId: 40, amount: 100000, at: '2026-10-31 12:00' }]);
    const { notified } = await run(SHOP, {
      watermark: { at: new Date('2026-10-31T00:00:00Z').getTime(), gated: true },
      gated: true,
    });
    expect(notified.map((g) => `${g.userId}:${g.milestoneKey}`)).toEqual([
      `${CREATOR}:earn:shop-sales-100000`,
    ]);
  });
});

/**
 * 🔴 The launch-burst guard. Each of these is a decision, not an accident: without a previous complete
 * run nothing can be told apart from a backlog, so ~150k qualifying creators would each be notified
 * at once. If you are about to relax one of these, the first ungated run in production is what it
 * breaks.
 */
describe('announcing', () => {
  const yesterday = (gated = false): PreviousRun => ({
    at: new Date('2026-10-31T00:00:00Z').getTime(),
    gated,
  });

  it('NO WATERMARK MEANS NO NOTIFICATIONS: a first run grants everything seen and announces nothing', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    await q(
      `INSERT INTO "UserMetric" ("userId", timeframe, "followerCount") VALUES ($1, 'AllTime', 150)`,
      [CREATOR]
    );
    const models = await run(MODELS);
    const followers = await run(FOLLOWERS);
    expect(models.notified).toEqual([]);
    expect(followers.notified).toEqual([]);
    expect(await held(CREATOR)).toEqual([
      { key: 'create:models-1', seen: true, at: '2026-10-31 12:00' },
      { key: 'reach:followers-100', seen: true, at: expect.any(String) },
    ]);
  });

  it('announces a dated milestone reached since the previous run, and not one from before it', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    await addModels(QUIET, ['2026-10-30 12:00']);
    const { notified } = await run(MODELS, { watermark: yesterday() });
    expect(notified.map((g) => `${g.userId}:${g.milestoneKey}`)).toEqual([
      `${CREATOR}:create:models-1`,
    ]);
    expect(await held(QUIET)).toEqual([
      { key: 'create:models-1', seen: true, at: '2026-10-30 12:00' },
    ]);
  });

  it.each([
    { when: 'both runs ungated', previousGated: false, gated: false, announced: true },
    { when: 'the previous run gated', previousGated: true, gated: false, announced: false },
    { when: 'this run gated', previousGated: false, gated: true, announced: false },
  ])(
    'an undated milestone, $when: announced=$announced',
    async ({ previousGated, gated, announced }) => {
      await q(
        `INSERT INTO "UserMetric" ("userId", timeframe, "followerCount") VALUES ($1, 'AllTime', 150)`,
        [CREATOR]
      );
      const { notified } = await run(FOLLOWERS, { watermark: yesterday(previousGated), gated });
      expect(notified.length > 0).toBe(announced);
      expect((await held(CREATOR)).map((r) => r.seen)).toEqual([!announced]);
    }
  );

  it('never announces a silent definition', async () => {
    await q(
      `INSERT INTO "ModelMetric" ("modelId", "userId", status, "downloadCount") VALUES (1, $1, 'Published', 150)`,
      [CREATOR]
    );
    const { notified } = await run(DOWNLOADS, { watermark: yesterday() });
    expect(notified).toEqual([]);
    expect(await held(CREATOR)).toEqual([
      { key: 'reach:downloads-100', seen: true, at: expect.any(String) },
    ]);
  });

  it('while gated, grants only the flag audience', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    await addModels(TESTER, ['2026-10-31 12:00']);
    const { result } = await run(MODELS, {
      watermark: yesterday(true),
      gated: true,
      audience: [TESTER],
    });
    expect(result).toMatchObject({ candidates: 2, audience: 1, granted: 1 });
    expect(await held(CREATOR)).toEqual([]);
    expect((await held(TESTER)).map((r) => r.key)).toEqual(['create:models-1']);
  });

  it('records the run, and a second run grants and announces nothing', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    const first = await run(MODELS, { watermark: yesterday() });
    expect([...first.rows.values()]).toEqual([
      { at: AFTER_LAUNCH.getTime(), gated: false, definitions: await fingerprintFor(MODELS) },
    ]);
    const second = await run(MODELS, { watermark: yesterday() });
    expect(second.result.granted).toBe(0);
    expect(second.notified).toEqual([]);
  });

  it('refuses to run a group whose definitions are not seeded, and records nothing', async () => {
    const { store, rows } = memoryStore();
    await expect(
      runActivityGroup(
        { ...MODELS, keys: [...MODELS.keys, 'create:models-999'] },
        {
          readPg: pg,
          writePg: pg,
          store,
          gated: false,
          audienceAmong: async (ids) => new Set(ids),
          notify: async () => undefined,
        }
      )
    ).rejects.toThrow('No CreatorMilestone row for create:models-999');
    expect(rows.size).toBe(0);
  });

  it('ungated, grants everyone but tells only the flag audience', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    await addModels(TESTER, ['2026-10-31 12:00']);
    const { notified } = await run(MODELS, { watermark: yesterday(), audience: [TESTER] });
    expect(notified.map((g) => g.userId)).toEqual([TESTER]);
    expect((await held(CREATOR)).map((r) => r.seen)).toEqual([false]);
  });

  it('grants and announces across chunks', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    await addModels(TESTER, ['2026-10-31 13:00']);
    const { notified } = await run(MODELS, { watermark: yesterday(), chunkSize: 1 });
    expect(notified.map((g) => g.userId).sort()).toEqual([CREATOR, TESTER]);
  });

  // publishedAt is stored in UTC with no zone; the cutoff must not move with the session's zone.
  it('compares the cutoff in UTC whatever the session zone', async () => {
    await addModels(CREATOR, ['2026-10-31 00:30']);
    await addModels(QUIET, ['2026-10-30 23:30']);
    await q(`SET TIME ZONE 'America/New_York'`);
    try {
      const { notified } = await run(MODELS, { watermark: yesterday() });
      expect(notified.map((g) => g.userId)).toEqual([CREATOR]);
    } finally {
      await q(`SET TIME ZONE 'UTC'`);
    }
  });

  it('leaves the watermark alone when a grant fails, so the next run is not told it completed', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    const { store, rows } = memoryStore();
    const failing = {
      cancellableQuery: async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO')) throw new Error('write failed');
        return (pg as { cancellableQuery: (s: string, p?: unknown[]) => unknown }).cancellableQuery(
          sql,
          params
        );
      },
    } as never;
    await expect(
      runActivityGroup(MODELS, {
        readPg: pg,
        writePg: failing,
        store,
        gated: false,
        audienceAmong: async (ids) => new Set(ids),
        notify: async () => undefined,
      })
    ).rejects.toThrow('write failed');
    expect(rows.size).toBe(0);
  });
});

describe('announceFromFor', () => {
  const launchedAt = new Date('2026-10-07T00:00:00Z');
  const previous = { at: new Date('2026-10-10T00:00:00Z').getTime(), gated: false };

  it('announces a timed group from the later of launch and the previous run', () => {
    const timed = { launchedAt, silent: false, timed: true };
    expect(announceFromFor(timed, previous, false)).toEqual(new Date(previous.at));
    expect(announceFromFor(timed, { ...previous, at: 0 }, false)).toEqual(launchedAt);
  });

  it('does not announce an undated group launched after the previous run', () => {
    const untimed = { launchedAt: new Date('2026-10-11T00:00:00Z'), silent: false, timed: false };
    expect(announceFromFor(untimed, previous, false)).toBeNull();
  });
});

describe('watermark definitions', () => {
  const rows = [
    { key: 'create:models-1', threshold: 1 },
    { key: 'create:models-5', threshold: 5 },
  ];

  it('fingerprints the keys and thresholds a run used, so adding a key or moving a threshold changes it', () => {
    const base = definitionsFingerprint(rows, false);
    expect(
      definitionsFingerprint([...rows, { key: 'create:models-50', threshold: 50 }], false)
    ).not.toBe(base);
    expect(
      definitionsFingerprint([rows[0], { key: 'create:models-5', threshold: 4 }], false)
    ).not.toBe(base);
  });

  it('does not depend on the order Postgres returns the rows in', () => {
    expect(definitionsFingerprint([...rows].reverse(), false)).toBe(
      definitionsFingerprint(rows, false)
    );
  });

  // Silence is in the fingerprint, not the key: turning a group's announcements on, or back on after a
  // silent spell, starts it over with a silent run instead of reviving an older announced watermark.
  it('changes when a group turns silent or announced, under the same watermark row', () => {
    expect(definitionsFingerprint(rows, true)).not.toBe(definitionsFingerprint(rows, false));
    expect(watermarkKeyFor(MODELS)).toBe(watermarkKeyFor({ ...MODELS, silent: true }));
    const [silentGroup] = activityDetectorGroups({
      'create:models-1': { ...creatorMilestoneRegistry['create:models-1'], silent: true },
    });
    const [announcedGroup] = activityDetectorGroups({
      'create:models-1': { ...creatorMilestoneRegistry['create:models-1'], silent: undefined },
    });
    expect(watermarkKeyFor(silentGroup)).toBe(watermarkKeyFor(announcedGroup));
  });

  // Keyed by group, not by definitions, so reverting a threshold cannot pick up a weeks-old row.
  it('treats a watermark recorded against other definitions as none, so the run is silent', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    const { notified, rows: stored } = await run(MODELS, {
      watermark: {
        at: new Date('2026-10-31T00:00:00Z').getTime(),
        gated: false,
        definitions: 'other',
      },
    });
    expect(notified).toEqual([]);
    expect(await held(CREATOR)).toEqual([
      { key: 'create:models-1', seen: true, at: '2026-10-31 12:00' },
    ]);
    expect([...stored.values()][0]).toMatchObject({ definitions: await fingerprintFor(MODELS) });
  });
});

/**
 * 🔴 Downloads stay silent by product decision: the per-model download notification already marks
 * the moment. Every other group is announced now that the journey page shows them. A group must be
 * wholly silent or wholly announced, since its tiers share one watermark row.
 */
describe('which activity groups announce', () => {
  it('announces every activity group except downloads', () => {
    expect(
      groups
        .filter((group) => group.silent)
        .flatMap((group) => group.keys)
        .sort()
    ).toEqual(milestoneKeysFor('modelDownloads').sort());
    expect(groups.filter((group) => !group.silent).length).toBeGreaterThan(0);
  });
});

describe('launch-day preview', () => {
  it('counts what an ungated run would grant, excluding accounts that cannot receive one', async () => {
    await addModels(CREATOR, [
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
    ]);
    await addModels(BANNED, ['2026-01-01']);
    const preview = await previewActivityGrants(pg, [MODELS]);
    expect(preview).toEqual([{ group: MODELS.id, users: 1, rows: 2 }]);
    expect(await held(CREATOR)).toEqual([]);
  });
});

/**
 * The journey page shows these counts as progress toward the milestones the detectors grant, so a
 * count that disagrees with its detector shows a bar that never fills, or fills without a badge.
 */
describe('journey progress values', () => {
  it('count what the detectors grant on, and nothing they exclude', async () => {
    await addModels(CREATOR, [
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
    ]);
    await addModels(CREATOR, ['2026-01-06'], 'Draft');
    await q(
      `INSERT INTO "Model" ("userId", status, "deletedAt", availability, mode, "publishedAt") VALUES
        ($1, 'Published', now(), 'Public', NULL, '2026-01-01'),
        ($1, 'Published', NULL, 'Private', NULL, '2026-01-01'),
        ($1, 'Published', NULL, 'Public', 'Archived', '2026-01-01')`,
      [CREATOR]
    );
    await q(
      `INSERT INTO "Article" ("userId", status, availability, "publishedAt") VALUES
        ($1, 'Published', 'Public', '2026-01-01'),
        ($1, 'Published', 'Private', '2026-01-01'),
        ($1, 'Published', 'Public', now() + interval '1 day')`,
      [CREATOR]
    );
    await q(
      `INSERT INTO "ModelMetric" ("modelId", "userId", status, availability, "downloadCount") VALUES
        (1, $1, 'Published', 'Public', 600),
        (4, $1, 'Published', 'Public', 600),
        (2, $1, 'Published', 'Private', 5000),
        (3, $1, 'Draft', 'Public', 5000)`,
      [CREATOR]
    );
    await q(
      `INSERT INTO "UserMetric" ("userId", timeframe, "followerCount", "reactionCount") VALUES
        ($1, 'AllTime', 120, 1000), ($1, 'Month', 9999, 999999)`,
      [CREATOR]
    );

    await q(`INSERT INTO "Cosmetic" (id, "createdById") VALUES (1, $1), (2, NULL)`, [CREATOR]);
    await q(`INSERT INTO "CosmeticShopItem" (id, "addedById") VALUES (50, $1)`, [CREATOR]);
    await addSales([
      { cosmeticId: 1, shopItemId: 40, amount: 70000, at: '2026-01-01' },
      { cosmeticId: null, shopItemId: 50, amount: 40000, at: '2026-01-02' },
      { cosmeticId: 1, shopItemId: 40, amount: 900000, at: '2026-01-03', refunded: true },
      { cosmeticId: 2, shopItemId: 40, amount: 900000, at: '2026-01-03' },
    ]);

    const [values] = await q<Record<ActivityMeasure, number>>(activityValuesSql, [CREATOR]);
    expect(values).toEqual({
      models: 5,
      articles: 1,
      downloads: 600,
      followers: 120,
      reactions: 1000,
      revenue: 110000,
    });

    for (const group of groups) await run(group);
    const granted = (await held(CREATOR)).map((row) => row.key).sort();
    const reached = Object.entries(creatorMilestoneRegistry)
      .filter(([key, entry]) => {
        const measure = activityMeasureOf(entry);
        const threshold = Number(key.split('-').pop());
        return measure && values[measure] >= threshold;
      })
      .map(([key]) => key)
      .sort();
    expect(granted).toEqual(reached);
    expect(granted.length).toBeGreaterThan(4);
  });

  it('read zero for a creator with nothing', async () => {
    const [values] = await q(activityValuesSql, [QUIET]);
    expect(values).toEqual({
      models: 0,
      articles: 0,
      downloads: 0,
      followers: 0,
      reactions: 0,
      revenue: 0,
    });
  });
});

describe('judge-vote detector', () => {
  const judgeGroup = (totals: unknown[]) => {
    const calls: { sql: string; settings: Record<string, string | number> }[] = [];
    const [group] = judgeVoteGroups(async (sql, settings) => {
      calls.push({ sql, settings });
      return totals;
    });
    return { group, calls };
  };

  it('grants every judge rank at or below the vote count', async () => {
    const { group, calls } = judgeGroup([
      { userId: CREATOR, votes: '1200' },
      { userId: TESTER, votes: '500' },
      { userId: QUIET, votes: '499' },
    ]);
    await run(group);

    expect(await held(CREATOR)).toEqual([
      { key: 'community:crucible-votes-1000', seen: expect.any(Boolean), at: expect.any(String) },
      { key: 'community:crucible-votes-500', seen: expect.any(Boolean), at: expect.any(String) },
    ]);
    expect((await held(TESTER)).map((row) => row.key)).toEqual(['community:crucible-votes-500']);
    expect(await held(QUIET)).toEqual([]);
    expect(group.timed).toBe(false);
    // Totals below the lowest rank stay in ClickHouse; the read-only flag rides on the request.
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe(judgeVoteTotalsSql(500));
    expect(calls[0].settings).toEqual({
      readonly: '1',
      max_execution_time: 60,
      max_result_rows: 1_000_000,
    });
  });

  // The fake ignores the SQL, so the text is what pins the filters: rows before 2026-10-04 carry
  // userId 0, and without `userId > 0` they would reach the guard below and fail every run.
  it('asks ClickHouse only for attributed totals at or above the lowest rank', () => {
    expect(judgeVoteTotalsSql(500)).toBe(`SELECT userId, count() AS votes
  FROM crucible_votes WHERE userId > 0 GROUP BY userId HAVING votes >= 500`);
  });

  it('announces a rank crossed after the previous complete run', async () => {
    const watermark = { at: new Date('2026-10-31T00:00:00Z').getTime(), gated: false };
    await run(judgeGroup([{ userId: CREATOR, votes: '600' }]).group, { watermark });
    const { notified } = await run(judgeGroup([{ userId: CREATOR, votes: '1200' }]).group, {
      watermark,
    });
    expect(
      notified.map(({ userId, milestoneKey, silent }) => ({ userId, milestoneKey, silent }))
    ).toEqual([{ userId: CREATOR, milestoneKey: 'community:crucible-votes-1000', silent: false }]);
  });

  it('fails, rather than finding nobody, when the replica has no rank rows yet', async () => {
    const [group] = judgeVoteGroups(async () => []);
    const emptyPg = {
      cancellableQuery: async () => ({
        result: async () => [{ min: null }],
        cancel: async () => undefined,
      }),
    } as never;
    await expect(
      (group as Extract<MilestoneDetectorGroup, { candidates: unknown }>).candidates(emptyPg)
    ).rejects.toThrow('No CreatorMilestone thresholds for the judge ranks');
  });

  it('records no complete run when ClickHouse fails', async () => {
    const [group] = judgeVoteGroups(async () => {
      throw new Error('ClickHouse unavailable');
    });
    const { store, rows } = memoryStore();
    await expect(
      runActivityGroup(group, {
        readPg: pg,
        writePg: pg,
        store,
        gated: false,
        now: AFTER_LAUNCH,
        audienceAmong: async (ids) => new Set(ids),
        notify: async () => undefined,
      })
    ).rejects.toThrow('ClickHouse unavailable');
    expect(rows.size).toBe(0);
  });

  it('does not offer a rank the judge already holds', async () => {
    await run(judgeGroup([{ userId: CREATOR, votes: '600' }]).group);
    const { group } = judgeGroup([{ userId: CREATOR, votes: '1200' }]);
    const candidates = await (
      group as Extract<MilestoneDetectorGroup, { candidates: unknown }>
    ).candidates(pg);
    // Undated: a dated row before the watermark would be granted silently.
    expect(candidates).toEqual([
      { userId: CREATOR, milestoneKey: 'community:crucible-votes-1000', achievedAt: null },
    ]);
  });

  it.each([
    ['an anonymous vote row', { userId: 0, votes: '500' }],
    ['a non-numeric user', { userId: 'x', votes: '500' }],
    ['a non-numeric count', { userId: CREATOR, votes: 'many' }],
  ])('refuses %s instead of granting from it', async (_, row) => {
    const { group } = judgeGroup([row]);
    await expect(run(group)).rejects.toThrow('crucible_votes returned a malformed total');
  });
});
