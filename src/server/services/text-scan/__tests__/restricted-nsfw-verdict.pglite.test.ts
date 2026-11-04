import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as DbLag from '~/server/db/db-lag-helpers';
import type * as ModeratorService from '~/server/services/moderator.service';

/**
 * A text-scan NSFW verdict on a model its owner marked minor, POI or SFW-only: the hold the scan
 * writes instead of flipping nsfw, and the moderator's ruling on it. Both statements run against
 * PGlite. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({
  trackModActivity: vi.fn(),
  updateModelNsfwLevels: vi.fn(),
  entityChanges: vi.fn(),
}));

vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: mocks.trackModActivity,
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLag>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));
// Hand-listed: each real module builds clients at load.
vi.mock('~/server/services/nsfwLevels.service', () => ({
  updateModelNsfwLevels: mocks.updateModelNsfwLevels,
}));
vi.mock('~/server/services/model-version.service', () => ({
  bustPublicModelResponseCache: vi.fn(),
}));
vi.mock('~/server/clickhouse/tracker', () => ({
  Tracker: class {
    entityChanges = mocks.entityChanges;
  },
}));

const { applySystemModelNsfwFlag } = await import('~/server/services/text-scan/actions/model-nsfw');
const { resolveRestrictedNsfwVerdict } = await import(
  '~/server/services/text-scan/actions/restricted-nsfw-verdict'
);

const MODEL = 41;
const OWNER = 52;
const MODERATOR = 3;
const SYSTEM_LOCK = { source: 'text-scan', at: '2026-11-01T00:00:00.000Z' };

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "lockedProperties" text[] NOT NULL DEFAULT '{}',
      nsfw boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false,
      "sfwOnly" boolean NOT NULL DEFAULT false,
      meta jsonb NOT NULL DEFAULT '{}',
      "deletedAt" timestamp(3)
    );
    CREATE TABLE "ModActivity" (
      id serial PRIMARY KEY,
      "userId" int,
      activity text NOT NULL,
      "entityType" text,
      "entityId" int,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
  `);
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  const tx = { $queryRaw: raw.queryRaw, $executeRaw: raw.executeRaw };
  dbMock.dbWrite.$transaction.mockImplementation(((fn: (t: typeof tx) => unknown) =>
    fn(tx)) as never);
});
afterAll(() => db.close());

type Seed = Partial<{
  nsfw: boolean;
  minor: boolean;
  poi: boolean;
  sfwOnly: boolean;
  locked: string[];
  meta: Record<string, unknown>;
}>;

async function seed({ nsfw = false, minor, poi, sfwOnly, locked = [], meta = {} }: Seed) {
  await db.exec(`DELETE FROM "Model"`);
  await db.query(
    `INSERT INTO "Model" (id, "userId", "lockedProperties", nsfw, poi, minor, "sfwOnly", meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [MODEL, OWNER, locked, nsfw, !!poi, !!minor, !!(sfwOnly ?? minor ?? poi), meta]
  );
}

const row = async () =>
  (
    await db.query<{
      nsfw: boolean;
      sfwOnly: boolean;
      lockedProperties: string[];
      meta: Record<string, any>;
    }>(`SELECT nsfw, "sfwOnly", "lockedProperties", meta FROM "Model" WHERE id = $1`, [MODEL])
  ).rows[0];

// What the scan's caller read, which a flag landing after the read makes stale.
const scanned = (over: Seed = {}) => ({
  id: MODEL,
  nsfw: false,
  nsfwLevel: 1,
  lockedProperties: [] as string[],
  userId: OWNER,
  minor: false,
  poi: false,
  sfwOnly: false,
  ...over,
});

const lead = (restriction: 'minor' | 'poi' | 'sfwOnly') => ({
  restrictedNsfwVerdict: { source: 'text-scan', at: '2026-11-04T00:00:00.000Z', restriction },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entityChanges.mockResolvedValue(undefined);
});

describe('the scan on a restricted model', () => {
  it.each(['minor', 'poi', 'sfwOnly'] as const)(
    'leaves a %s model SFW and unlocked, and holds the verdict',
    async (flag) => {
      await seed({ [flag]: true });
      expect(
        await applySystemModelNsfwFlag({ model: scanned({ [flag]: true }), source: 'text-scan' })
      ).toBe('held_restricted');
      const after = await row();
      expect(after.nsfw).toBe(false);
      expect(after.lockedProperties).toEqual([]);
      expect(after.meta).not.toHaveProperty('systemNsfwLock');
      expect(after.meta.restrictedNsfwVerdict).toEqual({
        source: 'text-scan',
        at: expect.any(String),
        restriction: flag === 'sfwOnly' ? 'sfwOnly' : flag,
      });
    }
  );

  it('holds instead of flipping when the owner marked it minor after the read', async () => {
    await seed({ minor: true });
    expect(await applySystemModelNsfwFlag({ model: scanned(), source: 'text-scan' })).toBe(
      'held_restricted'
    );
    expect((await row()).nsfw).toBe(false);
  });

  it('still flips an unrestricted model (positive control)', async () => {
    await seed({});
    expect(await applySystemModelNsfwFlag({ model: scanned(), source: 'text-scan' })).toBe(
      'applied'
    );
    expect(await row()).toMatchObject({ nsfw: true, lockedProperties: ['nsfw'] });
  });

  it('keeps a waiting lead as it is on redelivery', async () => {
    await seed({ sfwOnly: true, meta: lead('minor') });
    await applySystemModelNsfwFlag({ model: scanned({ sfwOnly: true }), source: 'xguard' });
    expect((await row()).meta.restrictedNsfwVerdict).toEqual(lead('minor').restrictedNsfwVerdict);
  });

  it('writes no lead over a lock a moderator set after the read', async () => {
    await seed({ minor: true, locked: ['nsfw'] });
    expect(
      await applySystemModelNsfwFlag({ model: scanned({ minor: true }), source: 'text-scan' })
    ).toBe('declined_race');
    expect((await row()).meta).toEqual({});
  });
});

describe('resolveRestrictedNsfwVerdict', () => {
  const rule = (ruling: 'keep' | 'dismiss' | 'rateNsfw', reason?: string) =>
    resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling, reason, userId: MODERATOR });

  it('keep on an old scan lock: turns nsfw off, lifts the system lock, records what it replaced', async () => {
    await seed({
      nsfw: true,
      minor: true,
      locked: ['nsfw', 'category'],
      meta: { systemNsfwLock: SYSTEM_LOCK, ...lead('minor'), other: 1 },
    });
    await rule('keep');
    const after = await row();
    expect(after).toMatchObject({ nsfw: false, lockedProperties: ['category'] });
    expect(after.meta).not.toHaveProperty('restrictedNsfwVerdict');
    expect(after.meta).not.toHaveProperty('systemNsfwLock');
    expect(after.meta.other).toBe(1);
    expect(after.meta.restrictedNsfwVerdictRulings).toEqual([
      expect.objectContaining({
        by: MODERATOR,
        ruling: 'keep',
        restriction: 'minor',
        prior: {
          nsfw: true,
          sfwOnly: true,
          lockedProperties: ['nsfw', 'category'],
          systemNsfwLock: SYSTEM_LOCK,
        },
      }),
    ]);
    expect(mocks.trackModActivity).toHaveBeenCalledWith(
      MODERATOR,
      { entityType: 'model', entityId: MODEL, activity: 'restrictedNsfwVerdict:keep' },
      expect.anything()
    );
    expect(mocks.updateModelNsfwLevels).toHaveBeenCalledWith([MODEL]);
  });

  it("keep never lifts a moderator's nsfw lock (no system marker)", async () => {
    await seed({ nsfw: true, sfwOnly: true, locked: ['nsfw'], meta: lead('sfwOnly') });
    await rule('keep');
    expect(await row()).toMatchObject({ nsfw: true, lockedProperties: ['nsfw'] });
    expect(mocks.updateModelNsfwLevels).not.toHaveBeenCalled();
  });

  it('refuses to dismiss a minor lead without a reason, and keeps the lead', async () => {
    await seed({ minor: true, meta: lead('minor') });
    await expect(rule('dismiss')).rejects.toThrow(/minor lead/);
    await expect(rule('dismiss', '   ')).rejects.toThrow(/minor lead/);
    expect((await row()).meta).toHaveProperty('restrictedNsfwVerdict');
    expect(mocks.trackModActivity).not.toHaveBeenCalled();
  });

  it('treats a lead held as minor as minor after the owner unticks it', async () => {
    await seed({ sfwOnly: true, meta: lead('minor') });
    await expect(rule('dismiss')).rejects.toThrow(/minor lead/);
    await expect(rule('rateNsfw')).rejects.toThrow(/cannot be rated NSFW/);
  });

  it('dismisses with a reason and changes nothing but the lead', async () => {
    await seed({ minor: true, meta: lead('minor') });
    await rule('dismiss', 'escalated to CSAM tools');
    const after = await row();
    expect(after).toMatchObject({ nsfw: false, sfwOnly: true, lockedProperties: [] });
    expect(after.meta).not.toHaveProperty('restrictedNsfwVerdict');
    expect(after.meta.restrictedNsfwVerdictRulings[0]).toMatchObject({
      ruling: 'dismiss',
      reason: 'escalated to CSAM tools',
    });
  });

  it('dismisses an SFW-only lead without a reason', async () => {
    await seed({ sfwOnly: true, meta: lead('sfwOnly') });
    await rule('dismiss');
    expect((await row()).meta).not.toHaveProperty('restrictedNsfwVerdict');
  });

  it.each(['minor', 'poi'] as const)('refuses Rate NSFW on a %s model', async (flag) => {
    await seed({ [flag]: true, meta: lead(flag) });
    await expect(rule('rateNsfw')).rejects.toThrow(/cannot be rated NSFW/);
    expect(await row()).toMatchObject({ nsfw: false, sfwOnly: true, lockedProperties: [] });
    expect((await row()).meta).toHaveProperty('restrictedNsfwVerdict');
  });

  it('Rate NSFW on an SFW-only lead: unsets sfwOnly, sets and locks nsfw as the moderator', async () => {
    await seed({ sfwOnly: true, meta: { ...lead('sfwOnly'), systemNsfwLock: SYSTEM_LOCK } });
    await rule('rateNsfw');
    const after = await row();
    expect(after).toMatchObject({ nsfw: true, sfwOnly: false, lockedProperties: ['nsfw'] });
    expect(after.meta).not.toHaveProperty('systemNsfwLock');
    expect(after.meta).not.toHaveProperty('restrictedNsfwVerdict');
  });

  it('refuses a second ruling on the same lead', async () => {
    await seed({ sfwOnly: true, meta: lead('sfwOnly') });
    await rule('dismiss');
    await expect(rule('keep')).rejects.toThrow(/ruled on meanwhile/);
    expect((await row()).meta.restrictedNsfwVerdictRulings).toHaveLength(1);
  });
});

describe('the backfill migration', () => {
  const sqlFile = readFileSync(
    path.resolve(
      __dirname,
      '../../../../../packages/civitai-db-schema/prisma/migrations/20261223120100_model_restricted_nsfw_verdict_backfill/migration.sql'
    ),
    'utf-8'
  );
  // The dry run and the write, as a person applies them: the write's transaction is left open by the
  // file (COMMIT is commented out) and committed here once the counts agree.
  const [dryRun, write] = sqlFile
    .split(/^BEGIN;$/m)
    .map((part) => part.replace(/^--.*$/gm, '').trim());

  const insert = (id: number, cols: Record<string, unknown>) =>
    db.query(
      `INSERT INTO "Model" (id, "userId", "lockedProperties", nsfw, minor, poi, "sfwOnly", meta)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        cols.locked ?? ['nsfw'],
        cols.nsfw ?? true,
        !!cols.minor,
        !!cols.poi,
        !!cols.sfwOnly,
        cols.meta ?? { systemNsfwLock: SYSTEM_LOCK },
      ]
    );

  it('stamps exactly the stuck models, and counts them first', async () => {
    await db.exec(`DELETE FROM "Model"; DELETE FROM "ModActivity";`);
    await insert(1, { minor: true, sfwOnly: true }); // stuck: minor
    await insert(2, { sfwOnly: true }); // stuck: SFW-only
    await insert(3, {}); // an ordinary system lock: not restricted
    await insert(4, { minor: true, sfwOnly: true, meta: {} }); // a moderator's lock: no marker
    await insert(5, { poi: true, sfwOnly: true }); // ruled by a moderator after the lock
    await db.query(
      `INSERT INTO "ModActivity" (activity, "entityType", "entityId", "createdAt")
       VALUES ('setPoi', 'model', 5, '2026-11-02')`
    );
    await insert(6, { sfwOnly: true, meta: { systemNsfwLock: SYSTEM_LOCK, ...lead('minor') } });

    expect((await db.query<{ to_backfill: number }>(dryRun)).rows[0].to_backfill).toBe(2);
    await db.exec('BEGIN');
    const statements = write.split(/;\s*$/m).filter((s) => s.trim());
    const result = await db.query<{ backfilled: number }>(statements[0]);
    expect(result.rows[0].backfilled).toBe(2);
    await db.exec('COMMIT');

    const leads = await db.query<{ id: number; lead: unknown }>(
      `SELECT id, meta->'restrictedNsfwVerdict' AS lead FROM "Model" ORDER BY id`
    );
    expect(leads.rows).toEqual([
      { id: 1, lead: { source: 'text-scan', at: SYSTEM_LOCK.at, restriction: 'minor' } },
      { id: 2, lead: { source: 'text-scan', at: SYSTEM_LOCK.at, restriction: 'sfwOnly' } },
      { id: 3, lead: null },
      { id: 4, lead: null },
      { id: 5, lead: null },
      { id: 6, lead: lead('minor').restrictedNsfwVerdict },
    ]);
    // Nothing but the lead changed.
    expect((await db.query(`SELECT count(*)::int AS n FROM "Model" WHERE nsfw`)).rows[0]).toEqual({
      n: 6,
    });
  });
});
