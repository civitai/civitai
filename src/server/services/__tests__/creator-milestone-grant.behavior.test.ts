import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mocks.createNotification,
}));

import type * as NotificationService from '~/server/services/notification.service';
import { applyUserScoreUpdates, persistScoreBatch } from '~/server/jobs/update-user-score';
import { creatorMilestoneRegistry } from '~/server/services/creator-milestone-registry';
import {
  backfillScoreTierBatch,
  grantMilestoneCosmeticsBatch,
  grantScoreTierMilestones,
  previewMilestoneCosmetics,
  previewScoreTierBackfill,
} from '~/server/services/creator-milestone-grant.service';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Runs the grant, backfill and preview SQL unmodified against the real creator_milestone migration
 * on an in-process Postgres. Every excluded account has an eligible twin that differs only in the
 * excluding property, so an exclusion that matched everyone would fail on the twin.
 */

const MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261005120000_creator_milestone/migration.sql'
);

const holder = { db: null as unknown as PGlite };
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
    cancel: async () => undefined,
  }),
} as never;

const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

const ELIGIBLE = 10;
const DELETED = 11;
const BANNED = 12;
const SYSTEM = -1;
const LATE = 13;
const NO_PRIOR_TOTAL = 14;

async function addUser(id: number, total: number | null, flag: 'deleted' | 'banned' | null = null) {
  await q(`INSERT INTO "User" (id, meta, "deletedAt", "bannedAt") VALUES ($1, $2, $3, $4)`, [
    id,
    total == null ? null : JSON.stringify({ scores: { total, models: total } }),
    flag === 'deleted' ? new Date() : null,
    flag === 'banned' ? new Date() : null,
  ]);
}

const held = (userId: number) =>
  q<{ milestoneKey: string; seen: boolean }>(
    `SELECT "milestoneKey", "seenAt" IS NOT NULL AS seen FROM "UserCreatorMilestone"
     WHERE "userId" = $1 ORDER BY "milestoneKey"`,
    [userId]
  );

async function attachCosmetic(key: string) {
  const [{ id }] = await q<{ id: number }>(`INSERT INTO "Cosmetic" DEFAULT VALUES RETURNING id`);
  await q(`UPDATE "CreatorMilestone" SET "cosmeticId" = $1 WHERE key = $2`, [id, key]);
  return id;
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb, "deletedAt" timestamp(3), "bannedAt" timestamp(3));
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY);
    CREATE TABLE "UserCosmetic" (
      "userId" int NOT NULL REFERENCES "User"(id),
      "cosmeticId" int NOT NULL REFERENCES "Cosmetic"(id),
      "obtainedAt" timestamp(3) NOT NULL DEFAULT now(),
      "claimKey" text NOT NULL DEFAULT 'claimed',
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
  // Definitions the score detector must ignore: another track below every score, and a score row
  // without a threshold. The migration seeds neither, so without them the track and threshold
  // filters would be untested.
  await holder.db.exec(`
    INSERT INTO "CreatorMilestone" (key, track, threshold, name)
    VALUES ('create:decoy', 'create', 1, 'Decoy'), ('score:unthresholded', 'score', NULL, 'Decoy');
  `);
});

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE "UserCosmetic", "UserCreatorMilestone", "User";
    UPDATE "CreatorMilestone" SET "cosmeticId" = NULL;
  `);
});

describe('nightly grant', () => {
  beforeEach(async () => {
    await addUser(ELIGIBLE, 400);
    await addUser(DELETED, 400, 'deleted');
    await addUser(BANNED, 400, 'banned');
    await addUser(SYSTEM, 400);
    await addUser(LATE, 4000);
    await addUser(NO_PRIOR_TOTAL, null);
  });

  async function runNight() {
    const transitions = await applyUserScoreUpdates(pg, [
      [String(ELIGIBLE), { models: 1200 }],
      [String(DELETED), { models: 1200 }],
      [String(BANNED), { models: 1200 }],
      [String(SYSTEM), { models: 1200 }],
      [String(LATE), { models: 3000 }],
      [String(NO_PRIOR_TOTAL), { models: 600 }],
    ]);
    return { transitions, crossings: await grantScoreTierMilestones(pg, transitions) };
  }

  it('reads each total from before and after the write', async () => {
    const { transitions } = await runNight();
    const byUser = Object.fromEntries(transitions.map((t) => [t.userId, t]));
    expect(byUser[ELIGIBLE]).toEqual({ userId: ELIGIBLE, oldTotal: 400, newTotal: 1200 });
    expect(byUser[LATE]).toEqual({ userId: LATE, oldTotal: 4000, newTotal: 3000 });
    expect(byUser[NO_PRIOR_TOTAL]).toEqual({
      userId: NO_PRIOR_TOTAL,
      oldTotal: null,
      newTotal: 600,
    });
  });

  it('announces only real crossings by eligible accounts', async () => {
    const { crossings } = await runNight();
    expect(crossings.map((c) => `${c.userId}:${c.milestoneKey}`).sort()).toEqual([
      `${ELIGIBLE}:score:kindle`,
      `${ELIGIBLE}:score:spark`,
      `${NO_PRIOR_TOTAL}:score:spark`,
    ]);
  });

  it('grants nothing to deleted, banned or system accounts', async () => {
    await runNight();
    expect(await held(DELETED)).toEqual([]);
    expect(await held(BANNED)).toEqual([]);
    expect(await held(SYSTEM)).toEqual([]);
    expect(await held(ELIGIBLE)).toHaveLength(2);
  });

  it('grants a tier the old total already held silently, as seen', async () => {
    await runNight();
    expect(await held(LATE)).toEqual([
      { milestoneKey: 'score:kindle', seen: true },
      { milestoneKey: 'score:spark', seen: true },
    ]);
  });

  it('grants nothing twice', async () => {
    const { transitions } = await runNight();
    expect(await grantScoreTierMilestones(pg, transitions)).toEqual([]);
    expect(await held(ELIGIBLE)).toHaveLength(2);
  });

  it('grants the cosmetic of a tier that has one, keyed by the tier, silent grants included', async () => {
    const cosmeticId = await attachCosmetic('score:spark');
    await runNight();
    const granted = await q(
      `SELECT "userId", "claimKey" FROM "UserCosmetic" WHERE "cosmeticId" = $1 ORDER BY 1`,
      [cosmeticId]
    );
    expect(granted).toEqual([
      { userId: ELIGIBLE, claimKey: 'score:spark' },
      { userId: LATE, claimKey: 'score:spark' },
      { userId: NO_PRIOR_TOTAL, claimKey: 'score:spark' },
    ]);
  });
});

describe('backfill', () => {
  beforeEach(async () => {
    await addUser(SYSTEM, 20_000_000);
    await addUser(ELIGIBLE, 20_000_000);
    await addUser(DELETED, 20_000_000, 'deleted');
    await addUser(BANNED, 20_000_000, 'banned');
    await addUser(LATE, 600);
    await addUser(NO_PRIOR_TOTAL, 100);
  });

  it('previews exactly what it then grants', async () => {
    const preview = await previewScoreTierBackfill(pg, { afterUserId: -10 });
    expect(preview).toEqual({ users: 2, rows: 10 });

    let cursor = -10;
    let inserted = 0;
    let users = 0;
    for (let i = 0; i < 10; i++) {
      const batch = await backfillScoreTierBatch(pg, { afterUserId: cursor, limit: 1 });
      if (!batch.users || batch.lastUserId == null) break;
      inserted += batch.inserted;
      users += batch.users;
      cursor = batch.lastUserId;
    }
    expect(inserted).toBe(preview.rows);
    expect(users).toBe(preview.users);
    expect(await previewScoreTierBackfill(pg, { afterUserId: -10 })).toEqual({
      users: 0,
      rows: 0,
    });
  });

  it('grants every tier of a user in one batch, all seen, and skips excluded accounts', async () => {
    const first = await backfillScoreTierBatch(pg, { afterUserId: -10, limit: 1 });
    expect(first).toEqual({ users: 1, inserted: 9, lastUserId: ELIGIBLE });
    const ladder = await held(ELIGIBLE);
    expect(ladder).toHaveLength(9);
    expect(ladder.every((row) => row.seen)).toBe(true);

    await backfillScoreTierBatch(pg, { afterUserId: ELIGIBLE, limit: 10 });
    expect(await held(SYSTEM)).toEqual([]);
    expect(await held(DELETED)).toEqual([]);
    expect(await held(BANNED)).toEqual([]);
    expect(await held(LATE)).toEqual([{ milestoneKey: 'score:spark', seen: true }]);
  });
});

describe('cosmetics for existing holders', () => {
  it('grants an attached cosmetic only to eligible holders, and revokes nothing', async () => {
    await addUser(ELIGIBLE, 600);
    await addUser(DELETED, 600);
    await addUser(BANNED, 600);
    await backfillScoreTierBatch(pg, { afterUserId: 0, limit: 10 });
    await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [DELETED]);
    await q(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [BANNED]);
    await attachCosmetic('score:spark');

    expect(await previewMilestoneCosmetics(pg, { afterUserId: 0 })).toEqual({ users: 1, rows: 1 });
    expect(await grantMilestoneCosmeticsBatch(pg, { afterUserId: 0, limit: 10 })).toEqual({
      users: 1,
      inserted: 1,
      lastUserId: ELIGIBLE,
    });
    expect(await q(`SELECT "userId", "claimKey" FROM "UserCosmetic"`)).toEqual([
      { userId: ELIGIBLE, claimKey: 'score:spark' },
    ]);
    expect(await held(DELETED)).toEqual([{ milestoneKey: 'score:spark', seen: true }]);
    expect(await held(BANNED)).toEqual([{ milestoneKey: 'score:spark', seen: true }]);

    const again = await grantMilestoneCosmeticsBatch(pg, { afterUserId: 0, limit: 10 });
    expect(again.inserted).toBe(0);
  });
});

describe('nightly grant before a definition launches', () => {
  const { launchedAt } = creatorMilestoneRegistry['score:spark'];
  const BEFORE_LAUNCH = new Date(launchedAt.getTime() - 1);
  const AFTER_LAUNCH = launchedAt;

  beforeAll(async () => {
    await q(
      `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isModerator" boolean NOT NULL DEFAULT false`
    );
  });

  beforeEach(async () => {
    mocks.createNotification.mockClear();
    // Moderators are always in the Creator Journey audience, so Flipt is never asked.
    await addUser(ELIGIBLE, 400);
    await q(`UPDATE "User" SET "isModerator" = true WHERE id = $1`, [ELIGIBLE]);
  });

  async function runBatch(now: Date) {
    const ctx = {
      pg,
      jobContext: { on: vi.fn(), checkIfCanceled: vi.fn() } as never,
      tierUnlocks: [],
      tierGrantErrors: [] as unknown[],
    };
    await persistScoreBatch(ctx, [[String(ELIGIBLE), { models: 600 }]], { now });
    expect(ctx.tierGrantErrors).toEqual([]);
  }

  const notifiedKeys = () =>
    mocks.createNotification.mock.calls.map(([n]) => (n as { key: string }).key);

  it('grants a crossing seen and announces nothing, leaving other unseen rows alone', async () => {
    await q(
      `INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey") VALUES ($1, 'score:kindle')`,
      [ELIGIBLE]
    );
    await runBatch(BEFORE_LAUNCH);
    expect(await held(ELIGIBLE)).toEqual([
      { milestoneKey: 'score:kindle', seen: false },
      { milestoneKey: 'score:spark', seen: true },
    ]);
    expect(notifiedKeys()).toEqual([]);
  });

  it('announces the same crossing unseen once the definition has launched', async () => {
    await runBatch(AFTER_LAUNCH);
    expect(await held(ELIGIBLE)).toEqual([{ milestoneKey: 'score:spark', seen: false }]);
    expect(notifiedKeys()).toEqual([`creator-score-tier-reached:${ELIGIBLE}:score:spark`]);
  });
});
