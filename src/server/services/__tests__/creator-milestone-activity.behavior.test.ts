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
  competeWinGroups,
  competeWinsSource,
  judgeVoteGroups,
  judgeVoteTotalsSql,
  ledgerWinCountSql,
  ledgerWinsSql,
} from '~/server/services/creator-milestone-detectors';
import type { ActivityMeasure } from '~/server/services/creator-milestone-registry';
import {
  activityMeasureOf,
  creatorMilestoneRegistry,
  milestoneKeysFor,
} from '~/server/services/creator-milestone-registry';
import type { MilestoneGrant } from '~/server/services/creator-milestone-grant.service';
import { getCruciblePrizeWinners } from '~/utils/crucible-helpers';

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
    CREATE TABLE "Challenge" (
      id int PRIMARY KEY, source text NOT NULL, "createdById" int, "collectionId" int,
      "endsAt" timestamp(3) NOT NULL
    );
    CREATE TABLE "ChallengeWinner" (
      id serial PRIMARY KEY, "challengeId" int NOT NULL, "userId" int NOT NULL, place int NOT NULL,
      "createdAt" timestamp(3) NOT NULL, UNIQUE ("challengeId", "userId")
    );
    CREATE TABLE "CollectionItem" (id serial PRIMARY KEY, "collectionId" int NOT NULL, "addedById" int);
    CREATE TABLE "Crucible" (
      id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL,
      "prizePositions" jsonb NOT NULL DEFAULT '[]', "prizePool" int NOT NULL DEFAULT 0,
      "endAt" timestamp(3), "updatedAt" timestamp(3)
    );
    CREATE TABLE "CrucibleEntry" (
      id serial PRIMARY KEY, "crucibleId" int NOT NULL, "userId" int NOT NULL, position int
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
      "CosmeticShopItem", "UserCosmeticShopPurchases", "UserCosmeticShopPurchaseCosmetic",
      "Challenge", "ChallengeWinner", "CollectionItem", "Crucible", "CrucibleEntry";
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
      wins: 0,
      crucibleWins: 0,
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
      wins: 0,
      crucibleWins: 0,
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

describe('compete-win detector', () => {
  type LedgerRow = { userId: unknown; at: unknown };
  const competeGroup = (ledger: LedgerRow[] = []) => {
    const calls: { sql: string; settings: Record<string, string | number> }[] = [];
    const [group] = competeWinGroups(async (sql, settings) => {
      calls.push({ sql, settings });
      return ledger;
    });
    return { group, calls };
  };
  const candidatesOf = (group: MilestoneDetectorGroup) =>
    (group as Extract<MilestoneDetectorGroup, { candidates: unknown }>).candidates(pg);

  let filler = 1000;
  // `others` entrants besides the winners, who add their own entries.
  async function addChallenge(
    id: number,
    { source = 'System', host = null as number | null, others = 20, endsAt = '2026-03-01' } = {}
  ) {
    await q(
      `INSERT INTO "Challenge" (id, source, "createdById", "collectionId", "endsAt")
       VALUES ($1, $2, $3, $1, $4::timestamp)`,
      [id, source, host, endsAt]
    );
    for (let i = 0; i < others; i++)
      await q(`INSERT INTO "CollectionItem" ("collectionId", "addedById") VALUES ($1, $2)`, [
        id,
        ++filler,
      ]);
  }
  async function addChallengeWin(challengeId: number, userId: number, at: string, place = 1) {
    await q(`INSERT INTO "CollectionItem" ("collectionId", "addedById") VALUES ($1, $2)`, [
      challengeId,
      userId,
    ]);
    await q(
      `INSERT INTO "ChallengeWinner" ("challengeId", "userId", place, "createdAt")
       VALUES ($1, $2, $3, $4::timestamp)`,
      [challengeId, userId, place, at]
    );
  }
  async function addCrucible(
    id: number,
    {
      host = TESTER,
      others = 20,
      endAt = '2026-03-01' as string | null,
      updatedAt = '2026-03-01',
      status = 'Completed',
      prizes = { 1: 50, 2: 30, 3: 20 } as Record<number, number>,
      pool = 1000,
    } = {}
  ) {
    await q(
      `INSERT INTO "Crucible" (id, "userId", status, "prizePositions", "prizePool", "endAt", "updatedAt")
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamp, $7::timestamp)`,
      [id, host, status, JSON.stringify(prizes), pool, endAt, updatedAt]
    );
    for (let i = 0; i < others; i++)
      await q(
        `INSERT INTO "CrucibleEntry" ("crucibleId", "userId", position) VALUES ($1, $2, NULL)`,
        [id, ++filler]
      );
  }
  async function addPlace(crucibleId: number, userId: number, position: number | null) {
    await q(`INSERT INTO "CrucibleEntry" ("crucibleId", "userId", position) VALUES ($1, $2, $3)`, [
      crucibleId,
      userId,
      position,
    ]);
  }

  it('counts daily challenges, community challenges and Crucibles, and dates each rung by the win that reached it', async () => {
    await addChallenge(1);
    await addChallengeWin(1, CREATOR, '2026-03-01 10:00');
    await addChallenge(2, { source: 'Mod' });
    await addChallengeWin(2, CREATOR, '2026-03-02 10:00', 3);
    // Ten entrants including the winner: the floor is inclusive.
    await addChallenge(3, { source: 'User', host: TESTER, others: 9 });
    await addChallengeWin(3, CREATOR, '2026-03-03 10:00');
    await addCrucible(4, { others: 9, endAt: '2026-03-04 10:00' });
    await addPlace(4, CREATOR, 2);
    const { group, calls } = competeGroup([{ userId: CREATOR, at: '2025-01-05 00:00:30' }]);

    await run(group);

    expect(await held(CREATOR)).toEqual([
      { key: 'compete:wins-1', seen: true, at: '2025-01-05 00:00' },
      { key: 'compete:wins-5', seen: true, at: '2026-03-04 10:00' },
    ]);
    // The journey page splits the same count: three challenges, one Crucible (the ledger win is added there).
    const [values] = await q<{ wins: number; crucibleWins: number }>(activityValuesSql, [CREATOR]);
    expect({ wins: values.wins, crucibleWins: values.crucibleWins }).toEqual({
      wins: 4,
      crucibleWins: 1,
    });
    expect(group.timed).toBe(true);
    expect(calls).toEqual([
      {
        sql: ledgerWinsSql,
        settings: { readonly: '1', max_execution_time: 60, max_result_rows: 1_000_000 },
      },
    ]);
  });

  it('counts nothing below 10 entrants, or in a contest the winner hosted', async () => {
    await addChallenge(1, { source: 'User', host: TESTER, others: 8 });
    await addChallengeWin(1, CREATOR, '2026-03-01 10:00');
    await addChallenge(2, { source: 'User', host: QUIET });
    await addChallengeWin(2, QUIET, '2026-03-01 10:00');
    await addCrucible(3, { others: 8 });
    await addPlace(3, CREATOR, 1);
    await addCrucible(4, { host: QUIET });
    await addPlace(4, QUIET, 1);

    expect(await candidatesOf(competeGroup().group)).toEqual([]);

    // The same contests, one entrant bigger or hosted by someone else, do count.
    await q(`INSERT INTO "CollectionItem" ("collectionId", "addedById") VALUES (1, 5000)`);
    await q(`INSERT INTO "CrucibleEntry" ("crucibleId", "userId") VALUES (3, 5000)`);
    await q(`UPDATE "Challenge" SET "createdById" = $1 WHERE id = 2`, [TESTER]);
    await q(`UPDATE "Crucible" SET "userId" = $1 WHERE id = 4`, [TESTER]);
    const rows = await candidatesOf(competeGroup().group);
    expect(rows.map(({ userId, milestoneKey }) => ({ userId, milestoneKey }))).toEqual(
      expect.arrayContaining([
        { userId: CREATOR, milestoneKey: 'compete:wins-1' },
        { userId: QUIET, milestoneKey: 'compete:wins-1' },
      ])
    );
    expect(rows).toHaveLength(2);
    const [creator] = await q<{ wins: number }>(activityValuesSql, [CREATOR]);
    const [quiet] = await q<{ wins: number }>(activityValuesSql, [QUIET]);
    expect([creator.wins, quiet.wins]).toEqual([2, 2]);
  });

  // 9 of 51 placer-Crucible pairs on prod held several paid places in one Crucible (2026-10-09).
  // Counting each place would pay for entering one Crucible many times.
  it('counts one win per Crucible however many paid places the entrant took, and none unpaid or unfinished', async () => {
    await addCrucible(1);
    await addPlace(1, CREATOR, 1);
    await addPlace(1, CREATOR, 2);
    await addPlace(1, CREATOR, 3);
    await addPlace(1, CREATOR, 4);
    await addCrucible(2, { status: 'Active' });
    await addPlace(2, CREATOR, 1);
    // Three creators above QUIET take the three prize places.
    await addCrucible(3);
    for (const [position, userId] of [2101, 2102, 2103].entries())
      await addPlace(3, userId, position + 1);
    await addPlace(3, QUIET, 4);

    await q(`UPDATE "CreatorMilestone" SET threshold = 2 WHERE key = 'compete:wins-5'`);
    try {
      const rows = (await candidatesOf(competeGroup().group)).filter((row) =>
        [CREATOR, QUIET].includes(row.userId)
      );
      expect(rows.map(({ userId, milestoneKey }) => ({ userId, milestoneKey }))).toEqual([
        { userId: CREATOR, milestoneKey: 'compete:wins-1' },
      ]);
    } finally {
      await q(`UPDATE "CreatorMilestone" SET threshold = 5 WHERE key = 'compete:wins-5'`);
    }
    const [values] = await q<{ wins: number }>(activityValuesSql, [CREATOR]);
    expect(values.wins).toBe(1);
  });

  it('NO WATERMARK MEANS NO NOTIFICATIONS: the first run grants every past win silently', async () => {
    await addChallenge(1);
    await addChallengeWin(1, CREATOR, '2026-11-02 10:00');
    const { notified } = await run(competeGroup().group);
    expect(notified).toEqual([]);
    expect(await held(CREATOR)).toEqual([
      { key: 'compete:wins-1', seen: true, at: '2026-11-02 10:00' },
    ]);
  });

  // A community challenge is judged up to days after it closes. Dated by its close, this win would
  // fall before the previous run and be granted without a word.
  it('announces a late-judged win by when it was recorded, not when the challenge closed', async () => {
    const watermark = { at: new Date('2026-11-01T00:00:00Z').getTime(), gated: false };
    await addChallenge(1, { source: 'User', host: TESTER, endsAt: '2026-10-29 00:00' });
    await addChallengeWin(1, CREATOR, '2026-11-01 06:00');
    await addChallenge(2, { endsAt: '2026-10-20 00:00' });
    await addChallengeWin(2, QUIET, '2026-10-20 00:01');

    const { notified } = await run(competeGroup().group, {
      watermark,
      now: new Date('2026-11-02T00:00:00Z'),
    });

    expect(
      notified.map(({ userId, milestoneKey, silent }) => ({ userId, milestoneKey, silent }))
    ).toEqual([{ userId: CREATOR, milestoneKey: 'compete:wins-1', silent: false }]);
    expect((await held(QUIET)).map((row) => row.key)).toEqual(['compete:wins-1']);
  });

  it('never grants a banned winner', async () => {
    await addChallenge(1);
    await addChallengeWin(1, BANNED, '2026-03-01 10:00');
    await run(competeGroup([{ userId: BANNED, at: '2025-01-05 00:00:30' }]).group);
    expect(await held(BANNED)).toEqual([]);
  });

  it('does not offer a rung the winner already holds', async () => {
    await addChallenge(1);
    await addChallengeWin(1, CREATOR, '2026-03-01 10:00');
    await run(competeGroup().group);
    expect(await held(CREATOR)).toHaveLength(1);
    expect(await candidatesOf(competeGroup().group)).toEqual([]);
  });

  it('counts a daily challenge win however few entered, and a community challenge with no host', async () => {
    await addChallenge(1, { others: 0 });
    await addChallengeWin(1, CREATOR, '2026-03-01 10:00');
    await addChallenge(2, { source: 'User', host: null, others: 9 });
    await addChallengeWin(2, QUIET, '2026-03-01 10:00');
    const rows = await candidatesOf(competeGroup().group);
    expect(rows.map((row) => row.userId).sort()).toEqual([CREATOR, QUIET].sort());
  });

  // Entrants are people, not entries: one account entering many times, or the host entering their
  // own contest, must not carry it over the floor.
  it('counts distinct entrants besides the host toward the floor', async () => {
    await addChallenge(1, { source: 'User', host: TESTER, others: 0 });
    for (const entrant of [2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, TESTER])
      for (let i = 0; i < 3; i++)
        await q(`INSERT INTO "CollectionItem" ("collectionId", "addedById") VALUES (1, $1)`, [
          entrant,
        ]);
    await addChallengeWin(1, CREATOR, '2026-03-01 10:00');
    await addCrucible(2, { host: TESTER, others: 0 });
    for (const entrant of [2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, TESTER])
      for (let i = 0; i < 3; i++) await addPlace(2, entrant, null);
    await addPlace(2, CREATOR, 1);

    expect(await candidatesOf(competeGroup().group)).toEqual([]);

    // One more distinct entrant carries both over.
    await q(`INSERT INTO "CollectionItem" ("collectionId", "addedById") VALUES (1, 2009)`);
    await addPlace(2, 2009, null);
    const rows = await candidatesOf(competeGroup().group);
    expect(rows.map(({ userId, milestoneKey }) => ({ userId, milestoneKey }))).toEqual([
      { userId: CREATOR, milestoneKey: 'compete:wins-1' },
    ]);
    const [values] = await q<{ wins: number }>(activityValuesSql, [CREATOR]);
    expect(values.wins).toBe(2);
  });

  // A host can create places with a 0% share; those pay nothing, so they are not prize places.
  it('does not count a Crucible place whose share of the pool is zero', async () => {
    await addCrucible(1, { prizes: { 1: 100, 2: 0 } });
    await addPlace(1, CREATOR, 2);
    await addPlace(1, QUIET, 1);
    const rows = await candidatesOf(competeGroup().group);
    expect(rows.map((row) => row.userId)).toEqual([QUIET]);
  });

  // A Crucible pays one prize per creator, for their best entry, so the next creator moves up a
  // prize place. The winner's stored position is not their prize place.
  it('counts a Crucible win by the prize place paid, after each creator keeps only their best entry', async () => {
    await addCrucible(1, { prizes: { 1: 50, 2: 0, 3: 50 } });
    await addPlace(1, QUIET, 1);
    await addPlace(1, QUIET, 2);
    // Ranked 3rd, paid 2nd: the 0% place.
    await addPlace(1, CREATOR, 3);
    await addCrucible(2, { prizes: { 1: 50, 2: 30, 3: 20 } });
    await addPlace(2, QUIET, 1);
    await addPlace(2, QUIET, 2);
    await addPlace(2, QUIET, 3);
    // Ranked 4th, paid 2nd.
    await addPlace(2, BANNED, 4);
    await addPlace(2, TESTER + 100, 5);

    const rows = await candidatesOf(competeGroup().group);
    const won = rows.map((row) => row.userId).sort((a, b) => a - b);
    // BANNED is a candidate (the grant step filters standing) and is ranked like anyone else.
    expect(won).toEqual([QUIET, BANNED, TESTER + 100].sort((a, b) => a - b));
    const [paid2nd] = await q<{ wins: number }>(activityValuesSql, [BANNED]);
    expect(paid2nd.wins).toBe(1);
    // Ranked by their best entry: 1st in both, so two wins.
    const [quiet] = await q<{ wins: number }>(activityValuesSql, [QUIET]);
    expect(quiet.wins).toBe(2);
    const [creator] = await q<{ wins: number }>(activityValuesSql, [CREATOR]);
    expect(creator.wins).toBe(0);
  });

  // The host's entries rank like anyone's when prizes are paid; the host just cannot win.
  it("ranks the host's own entries, so a host finishing first moves the next creator to 2nd", async () => {
    await addCrucible(1, { host: TESTER, prizes: { 1: 100, 2: 0 } });
    await addPlace(1, TESTER, 1);
    await addPlace(1, CREATOR, 2);
    await addCrucible(2, { host: TESTER, prizes: { 1: 0, 2: 100 } });
    await addPlace(2, TESTER, 1);
    await addPlace(2, QUIET, 2);
    const rows = await candidatesOf(competeGroup().group);
    expect(rows.map((row) => row.userId)).toEqual([QUIET]);
  });

  // A place pays its share of the pool, rounded down; a free Crucible with no seed pays nobody.
  it('counts a Crucible place only when its share of the pool comes to at least 1 Buzz', async () => {
    await addCrucible(1, { pool: 0 });
    await addPlace(1, CREATOR, 1);
    await addCrucible(2, { pool: 2 });
    await addPlace(2, QUIET, 1);
    await addPlace(2, BANNED, 2);
    const rows = await candidatesOf(competeGroup().group);
    // 50% of 2 is 1 Buzz; 30% of 2 rounds down to 0.
    expect(rows.map((row) => row.userId)).toEqual([QUIET]);
  });

  // The detector's SQL restates the payout rule (one prize per creator, the next creator moves
  // up). If either side changes alone, this disagrees.
  it('agrees with getCruciblePrizeWinners on who a Crucible paid', async () => {
    const cases: {
      prizes: Record<number, number>;
      pool: number;
      placed: [userId: number, position: number][];
    }[] = [
      {
        prizes: { 1: 50, 2: 30, 3: 20 },
        pool: 1000,
        placed: [
          [3001, 1],
          [3001, 2],
          [3002, 3],
          [3003, 4],
          [3004, 5],
        ],
      },
      {
        prizes: { 1: 50, 2: 0, 3: 50 },
        pool: 1000,
        placed: [
          [3001, 1],
          [3002, 2],
          [3002, 3],
          [3003, 4],
          [3004, 5],
        ],
      },
      {
        prizes: { 1: 50, 2: 30, 3: 20 },
        pool: 3,
        placed: [
          [3001, 1],
          [3002, 2],
          [3003, 3],
        ],
      },
      {
        prizes: { 1: 60, 2: 40 },
        pool: 500,
        placed: [
          [TESTER, 1],
          [3001, 2],
          [3001, 3],
          [3002, 4],
        ],
      },
      {
        prizes: { 1: 100 },
        pool: 0,
        placed: [
          [3001, 1],
          [3002, 2],
        ],
      },
    ];
    for (const [index, { prizes, pool, placed }] of cases.entries()) {
      const id = 100 + index;
      await addCrucible(id, { prizes, pool });
      for (const [userId, position] of placed) await addPlace(id, userId, position);
    }

    for (const [index, { prizes, pool, placed }] of cases.entries()) {
      const paid = getCruciblePrizeWinners({
        placed: placed.map(([userId, position], entryId) => ({ entryId, userId, position })),
        prizePositions: Object.entries(prizes).map(([position, percentage]) => ({
          position: Number(position),
          percentage,
        })),
        totalPrizePool: pool,
      })
        .filter((winner) => winner.prizeAmount > 0 && winner.userId !== TESTER)
        .map((winner) => winner.userId)
        .sort((a, b) => a - b);
      // Creators recur across cases, so read the win per Crucible rather than per milestone.
      const won = [];
      for (const userId of new Set(placed.map(([userId]) => userId))) {
        if (userId === TESTER) continue;
        const [{ hit }] = await q<{ hit: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM (${competeWinsSource}) s
             WHERE s."userId" = $1 AND s.contest = $2) AS hit`,
          [userId, `crucible:${100 + index}`]
        );
        if (hit) won.push(userId);
      }
      expect({ case: index, won: won.sort((a, b) => a - b) }).toEqual({ case: index, won: paid });
    }
  });

  // An undated grant is announced whenever anything is, so a Crucible missing its end would
  // announce a historic win; it falls back to when the row last changed.
  it('dates a Crucible without an end by when it was last updated', async () => {
    await addCrucible(1, { endAt: null, updatedAt: '2026-03-05 12:00' });
    await addPlace(1, CREATOR, 1);
    const rows = await candidatesOf(competeGroup().group);
    expect(rows.map((row) => row.achievedAt?.toISOString())).toEqual(['2026-03-05T12:00:00.000Z']);
  });

  // While grants are flag-gated an undated group announces nothing, so only a dated (timed) group
  // can tell a fresh win from a backlog that joins the audience later.
  it('announces a fresh win during a gated run, as a dated group', async () => {
    const watermark = { at: new Date('2026-11-01T00:00:00Z').getTime(), gated: true };
    await addChallenge(1);
    await addChallengeWin(1, CREATOR, '2026-11-01 06:00');

    const { notified } = await run(competeGroup().group, {
      watermark,
      gated: true,
      audience: [CREATOR],
      now: new Date('2026-11-02T00:00:00Z'),
    });

    expect(notified.map(({ userId, milestoneKey }) => ({ userId, milestoneKey }))).toEqual([
      { userId: CREATOR, milestoneKey: 'compete:wins-1' },
    ]);
  });

  // The fake ignores the SQL, so the text is what pins the ledger rule. Wins paid before the winners
  // table carry the date format; the '#N: <title>' format is the table's own, and counting it again
  // would double every win since 2026-02-11.
  it('reads only old-format challenge prizes from the ledger, one per user and description', () => {
    const filter = `date < '2026-03-01' AND fromAccountId = 0 AND type = 'reward'
    AND match(description, '^Challenge Winner Prize [0-9]+: [0-9]{4}-[0-9]{2}-[0-9]{2}$')`;
    expect(ledgerWinsSql).toBe(`SELECT toAccountId AS userId,
    formatDateTime(min(date), '%Y-%m-%d %H:%i:%S', 'UTC') AS at
  FROM buzzTransactions
  WHERE toAccountId > 0 AND ${filter}
  GROUP BY toAccountId, description`);
    expect(ledgerWinCountSql).toBe(`SELECT count() AS wins FROM (
    SELECT description FROM buzzTransactions
    WHERE toAccountId = {userId:Int32} AND ${filter}
    GROUP BY description
  )`);

    const pattern = new RegExp(/match\(description, '(.+)'\)/.exec(filter)?.[1] ?? 'unmatched');
    expect(pattern.test('Challenge Winner Prize 2: 2024-11-29')).toBe(true);
    expect(pattern.test('Challenge Winner Prize 1: 2026-02-09')).toBe(true);
    expect(pattern.test('Challenge Winner Prize #3: The Great Granny Contest')).toBe(false);
    expect(pattern.test('Challenge Winner Prize #1: 2026-02-09')).toBe(false);
    expect(pattern.test('Challenge Winner Prize 2: 2024-11-29 (retry)')).toBe(false);
  });

  it.each([
    ['an anonymous ledger row', { userId: 0, at: '2025-01-05 00:00:30' }],
    ['a non-numeric user', { userId: 'x', at: '2025-01-05 00:00:30' }],
    ['an unparseable date', { userId: CREATOR, at: 'yesterday' }],
    ['a missing date', { userId: CREATOR, at: null }],
  ])('refuses %s instead of granting from it', async (_, row) => {
    await expect(run(competeGroup([row]).group)).rejects.toThrow(
      'buzzTransactions returned a malformed challenge win'
    );
  });

  it('records no complete run when ClickHouse fails', async () => {
    const [group] = competeWinGroups(async () => {
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
});
