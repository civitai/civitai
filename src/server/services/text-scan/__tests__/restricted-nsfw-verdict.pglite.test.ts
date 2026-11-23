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
  bustPublicModelResponseCache: vi.fn(async () => undefined),
}));
vi.mock('~/server/clickhouse/tracker', () => ({
  Tracker: class {
    entityChanges = mocks.entityChanges;
  },
}));

const {
  applyHeldRestrictedVerdict,
  applyHeldVerdictLeavingPrivate,
  applyModelNsfwTextScan,
  applySystemModelNsfwFlag,
  holdLeadAfterSfwOnlyLift,
} = await import('~/server/services/text-scan/actions/model-nsfw');
const { currentRestrictedLeadRevision, resolveRestrictedNsfwVerdict } = await import(
  '~/server/services/text-scan/actions/restricted-nsfw-verdict'
);
const { restrictedLeadRevision } = await import('@civitai/shared/restricted-lead-revision');
const { resolveRestrictedNsfwVerdictInput, restrictedNsfwRulingArgs } = await import(
  '~/server/schema/moderator/restricted-nsfw-verdict'
);

const { rollbackMinorHashAutoFlags } = await import('~/server/services/minor-hash.service');

const MODEL = 41;
const OWNER = 52;
const MODERATOR = 3;
const SYSTEM_LOCK = { source: 'text-scan', at: '2026-11-01T00:00:00.000Z' };

let db: PGlite;
const txReads: string[] = [];

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
      availability text NOT NULL DEFAULT 'Public',
      meta jsonb NOT NULL DEFAULT '{}',
      "deletedAt" timestamp(3)
    );
    CREATE TABLE "EntityModeration" (
      "entityType" text NOT NULL,
      "entityId" int NOT NULL,
      "triggeredLabels" text[] NOT NULL DEFAULT '{}',
      result jsonb,
      "contentHash" text,
      "nsfwLevel" int,
      UNIQUE ("entityType", "entityId")
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
  dbMock.dbRead.$queryRaw.mockImplementation(raw.queryRaw as never);
  // Its own handle, apart from dbWrite and dbRead, so a read off the transaction is seen; it keeps
  // the text of each read, in order.
  const tx = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      txReads.push(strings.join('?'));
      return (raw.queryRaw as (...a: unknown[]) => unknown)(strings, ...values);
    },
    $executeRaw: raw.executeRaw,
  };
  dbMock.dbWrite.$transaction.mockImplementation(((fn: (t: typeof tx) => unknown) =>
    fn(tx)) as never);
  dbMock.dbWrite.model.findUnique.mockImplementation(
    (async () =>
      (
        await db.query(
          `SELECT id, nsfw, 1 AS "nsfwLevel", "lockedProperties", "userId", minor, poi, "sfwOnly", availability, meta
         FROM "Model" WHERE id = $1`,
          [MODEL]
        )
      ).rows[0] ?? null) as never
  );
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
  await db.exec(`DELETE FROM "Model"; DELETE FROM "EntityModeration"`);
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
const scanned = (over: Partial<Parameters<typeof applySystemModelNsfwFlag>[0]['model']> = {}) => ({
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
  mocks.trackModActivity.mockResolvedValue(undefined);
});

describe('the scan on a restricted model', () => {
  it.each(['minor', 'poi'] as const)(
    'never writes nsfw on a %s model, and holds the verdict',
    async (flag) => {
      await seed({ [flag]: true });
      expect(
        await applySystemModelNsfwFlag({ model: scanned({ [flag]: true }), source: 'text-scan' })
      ).toBe('held_restricted');
      const after = await row();
      expect(after).toMatchObject({ nsfw: false, sfwOnly: true, lockedProperties: [] });
      expect(after.meta).not.toHaveProperty('systemNsfwLock');
      expect(after.meta.restrictedNsfwVerdict).toEqual({
        source: 'text-scan',
        at: expect.any(String),
        restriction: flag,
      });
    }
  );

  it('rates an SFW-only model at once: SFW-only off, nsfw on (unlocked), and a lead with what it replaced', async () => {
    await seed({ sfwOnly: true, locked: ['category'], meta: { other: 1 } });
    expect(
      await applySystemModelNsfwFlag({ model: scanned({ sfwOnly: true }), source: 'text-scan' })
    ).toBe('applied');
    const after = await row();
    expect(after).toMatchObject({
      nsfw: true,
      sfwOnly: false,
      lockedProperties: ['category'],
    });
    expect(after.meta.other).toBe(1);
    expect(after.meta.systemNsfwLock).toEqual({ source: 'text-scan', at: expect.any(String) });
    const prior = {
      nsfw: false,
      sfwOnly: true,
      lockedProperties: ['category'],
      systemNsfwLock: null,
    };
    expect(after.meta.restrictedNsfwVerdict).toEqual({
      source: 'text-scan',
      at: expect.any(String),
      restriction: 'sfwOnly',
      applied: { at: after.meta.systemNsfwLock.at, prior },
    });
    expect(after.meta.restrictedNsfwVerdictRulings).toEqual([
      expect.objectContaining({ ruling: 'autoApply', restriction: 'sfwOnly', prior }),
    ]);
    expect(mocks.trackModActivity).toHaveBeenCalledWith(expect.any(Number), {
      entityType: 'model',
      entityId: MODEL,
      activity: 'restrictedNsfwVerdict:autoApply',
    });
  });

  it('holds instead of flipping when the owner marked it minor after the read', async () => {
    await seed({ minor: true });
    expect(await applySystemModelNsfwFlag({ model: scanned(), source: 'text-scan' })).toBe(
      'held_restricted'
    );
    expect((await row()).nsfw).toBe(false);
  });

  it('flips when the owner cleared minor after the read, instead of dropping the verdict', async () => {
    await seed({});
    expect(
      await applySystemModelNsfwFlag({ model: scanned({ minor: true }), source: 'text-scan' })
    ).toBe('applied');
    expect(await row()).toMatchObject({ nsfw: true, lockedProperties: [] });
  });

  it('still flips an unrestricted model (positive control)', async () => {
    await seed({});
    expect(await applySystemModelNsfwFlag({ model: scanned(), source: 'text-scan' })).toBe(
      'applied'
    );
    const after = await row();
    expect(after).toMatchObject({ nsfw: true, lockedProperties: [] });
    expect(after.meta).not.toHaveProperty('restrictedNsfwVerdict');
    expect(mocks.trackModActivity).not.toHaveBeenCalled();
  });

  // Without the marker the owner could untick mature, or remove the face, and nothing would rescan it.
  it('records the verdict as the origin marker on a model already mature', async () => {
    await seed({ nsfw: true });
    expect(
      await applySystemModelNsfwFlag({ model: scanned({ nsfw: true }), source: 'text-scan' })
    ).toBe('skipped_nsfw');
    const after = await row();
    expect(after).toMatchObject({ nsfw: true, lockedProperties: [] });
    expect(after.meta.systemNsfwLock).toEqual({ source: 'text-scan', at: expect.any(String) });
  });

  describe('a rescan that reads the text as not mature', () => {
    const clean = {
      entityId: MODEL,
      workflowId: 'wf',
      textHash: 'h',
      outcome: {
        nsfw: { detectedLevel: 2, declaredLevel: 32, raised: false, reason: 'r' },
        triggeredLabels: [],
        nsfwLevel: 2,
      },
      subject: { fields: [], declared: {} },
    } as unknown as Parameters<typeof applyModelNsfwTextScan>[0];

    it("drops the scan's own marker, so the owner can change the rating; the rating stays", async () => {
      await seed({ nsfw: true, meta: { systemNsfwLock: SYSTEM_LOCK, other: 1 } });
      await applyModelNsfwTextScan(clean);
      expect(await row()).toMatchObject({ nsfw: true, meta: { other: 1 } });
      expect((await row()).meta).not.toHaveProperty('systemNsfwLock');
    });

    it('drops a scan marker an intent lock parked, so lifting that lock does not bring it back', async () => {
      await seed({
        nsfw: true,
        locked: ['nsfw'],
        meta: {
          systemNsfwLock: { source: 'com-face-intent', at: 'x' },
          comFaceIntent: { detected: true, priorSystemNsfwLock: SYSTEM_LOCK },
        },
      });
      await applyModelNsfwTextScan(clean);
      const { meta } = await row();
      expect(meta.comFaceIntent).toEqual({ detected: true });
      expect(meta.systemNsfwLock).toMatchObject({ source: 'com-face-intent' });
    });

    it.each([
      ['another check', { meta: { systemNsfwLock: { source: 'com-face-intent', at: 'x' } } }],
      ['a lock', { locked: ['nsfw'], meta: { systemNsfwLock: SYSTEM_LOCK } }],
    ])('keeps a marker under %s', async (_, over) => {
      await seed({ nsfw: true, ...over });
      await applyModelNsfwTextScan(clean);
      expect((await row()).meta).toHaveProperty('systemNsfwLock');
    });
  });

  // A marker blocks the owner (assertScanRatingKept) only where a clean read can release it.
  // As on main: the owner's way out of an xguard rating is the lock or rating review.
  it('locks an xguard rating with its marker, flipped or already mature', async () => {
    await seed({});
    expect(
      await applySystemModelNsfwFlag({ model: scanned(), source: 'xguard-text-moderation' })
    ).toBe('applied');
    expect(await row()).toMatchObject({ nsfw: true, lockedProperties: ['nsfw'] });
    expect((await row()).meta.systemNsfwLock).toMatchObject({ source: 'xguard-text-moderation' });

    await seed({ nsfw: true });
    await applySystemModelNsfwFlag({
      model: scanned({ nsfw: true }),
      source: 'xguard-text-moderation',
    });
    expect(await row()).toMatchObject({ nsfw: true, lockedProperties: ['nsfw'] });
  });

  describe('a verdict that lands under a lock', () => {
    it("is recorded under the listing check's lock, for whoever lifts it", async () => {
      await seed({
        nsfw: true,
        locked: ['nsfw'],
        meta: {
          systemNsfwLock: { source: 'com-face-intent', at: '2026-01-01T00:00:00.000Z' },
          comFaceIntent: { detected: true, textHash: 'h', at: 'x' },
        },
      });
      expect(
        await applySystemModelNsfwFlag({
          model: scanned({ nsfw: true, nsfwLevel: 60, lockedProperties: ['nsfw'] }),
          source: 'xguard-text-moderation',
        })
      ).toBe('skipped_locked');
      expect((await row()).meta.comFaceIntent.laterVerdict).toMatchObject({
        source: 'xguard-text-moderation',
      });
    });

    it("writes nothing under a moderator's lock", async () => {
      await seed({ nsfw: true, locked: ['nsfw'], meta: { comFaceIntent: { detected: true } } });
      expect(
        await applySystemModelNsfwFlag({
          model: scanned({ nsfw: true, nsfwLevel: 60, lockedProperties: ['nsfw'] }),
          source: 'text-scan',
        })
      ).toBe('skipped_locked');
      expect((await row()).meta.comFaceIntent).toEqual({ detected: true });
    });
  });

  it('locks for a source it does not know, by default', async () => {
    await seed({});
    await applySystemModelNsfwFlag({ model: scanned(), source: 'some-later-check' });
    expect(await row()).toMatchObject({ nsfw: true, lockedProperties: ['nsfw'] });
  });

  it('rates a model listed on .com by its face, so removing the face later leaves it mature', async () => {
    await seed({});
    expect(
      await applySystemModelNsfwFlag({
        model: scanned({ sfwName: 'Safe', sfwCoverImageId: 5, nsfwLevel: 1 }),
        source: 'text-scan',
      })
    ).toBe('applied');
    expect(await row()).toMatchObject({ nsfw: true, lockedProperties: [] });
  });

  it("keeps an earlier marker's time, and marks nothing under a moderator's lock", async () => {
    await seed({ nsfw: true, meta: { systemNsfwLock: SYSTEM_LOCK } });
    await applySystemModelNsfwFlag({ model: scanned({ nsfw: true }), source: 'text-scan' });
    expect((await row()).meta.systemNsfwLock).toEqual(SYSTEM_LOCK);

    await seed({ nsfw: true, locked: ['nsfw'] });
    await applySystemModelNsfwFlag({
      model: scanned({ nsfw: true, lockedProperties: ['nsfw'] }),
      source: 'text-scan',
    });
    expect((await row()).meta).not.toHaveProperty('systemNsfwLock');
  });

  it('keeps a waiting lead as it is on redelivery', async () => {
    await seed({ minor: true, meta: lead('minor') });
    await applySystemModelNsfwFlag({ model: scanned({ minor: true }), source: 'xguard' });
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

  it('asks a reason to dismiss or rate NSFW a lead held as minor after the owner unticks it', async () => {
    await seed({ sfwOnly: true, meta: lead('minor') });
    await expect(rule('dismiss')).rejects.toThrow(/minor lead/);
    await expect(rule('rateNsfw')).rejects.toThrow(/once marked minor/);
    await expect(rule('rateNsfw', '  ')).rejects.toThrow(/once marked minor/);
    expect(await row()).toMatchObject({ nsfw: false, sfwOnly: true });
    expect(mocks.trackModActivity).not.toHaveBeenCalled();

    await rule('rateNsfw', 'Adult character, checked the gallery');
    const after = await row();
    expect(after).toMatchObject({ nsfw: true, sfwOnly: false, lockedProperties: ['nsfw'] });
    expect(after.meta.restrictedNsfwVerdictRulings.at(-1)).toMatchObject({
      ruling: 'rateNsfw',
      restriction: 'minor',
      reason: 'Adult character, checked the gallery',
    });
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

  it("keep on an automatic SFW-only rating puts the owner's rating back", async () => {
    await seed({ sfwOnly: true });
    await applySystemModelNsfwFlag({ model: scanned({ sfwOnly: true }), source: 'text-scan' });
    await rule('keep');
    const after = await row();
    expect(after).toMatchObject({ nsfw: false, sfwOnly: true, lockedProperties: [] });
    expect(after.meta).not.toHaveProperty('systemNsfwLock');
    expect(after.meta).not.toHaveProperty('restrictedNsfwVerdict');
    expect(
      after.meta.restrictedNsfwVerdictRulings.map((r: { ruling: string }) => r.ruling)
    ).toEqual(['autoApply', 'keep']);
  });

  it('keep leaves a lock a later scan set after the lead', async () => {
    await seed({
      nsfw: true,
      sfwOnly: false,
      locked: ['nsfw'],
      meta: {
        ...lead('minor'),
        systemNsfwLock: { source: 'text-scan', at: '2026-11-05T00:00:00.000Z' },
      },
    });
    await rule('keep');
    const after = await row();
    expect(after).toMatchObject({ nsfw: true, lockedProperties: ['nsfw'] });
    expect(after.meta).toHaveProperty('systemNsfwLock');
    expect(after.meta).not.toHaveProperty('restrictedNsfwVerdict');
  });

  it('keep turns nsfw off where nothing locks it any more', async () => {
    await seed({ nsfw: true, sfwOnly: true, meta: lead('sfwOnly') });
    await rule('keep');
    expect(await row()).toMatchObject({ nsfw: false, sfwOnly: true });
  });

  it('allows Rate NSFW on a lead held as a real person once the owner unticks it', async () => {
    await seed({ sfwOnly: true, meta: lead('poi') });
    await rule('rateNsfw');
    expect(await row()).toMatchObject({ nsfw: true, sfwOnly: false, lockedProperties: ['nsfw'] });
  });

  it.each(['minor', 'poi'] as const)(
    'keep turns nsfw off on an unlocked %s model that still has it on',
    async (flag) => {
      await seed({ nsfw: true, [flag]: true, sfwOnly: false, meta: lead(flag) });
      await rule('keep');
      expect(await row()).toMatchObject({ nsfw: false, lockedProperties: [] });
    }
  );

  it("keep leaves the owner's own NSFW rating on a model no longer restricted", async () => {
    await seed({ nsfw: true, sfwOnly: false, meta: lead('poi') });
    await rule('keep');
    const after = await row();
    expect(after).toMatchObject({ nsfw: true, sfwOnly: false, lockedProperties: [] });
    expect(after.meta).not.toHaveProperty('restrictedNsfwVerdict');
  });

  it('refuses Rate NSFW on an SFW-only lead once the owner marks the model minor', async () => {
    await seed({ minor: true, meta: lead('sfwOnly') });
    await expect(rule('rateNsfw')).rejects.toThrow(/cannot be rated NSFW/);
    await expect(rule('dismiss')).rejects.toThrow(/minor lead/);
  });

  it('keeps only the last five rulings', async () => {
    const old = Array.from({ length: 5 }, (_, i) => ({ ruling: 'dismiss', at: `old-${i}` }));
    await seed({ sfwOnly: true, meta: { ...lead('sfwOnly'), restrictedNsfwVerdictRulings: old } });
    await rule('dismiss');
    const rulings = (await row()).meta.restrictedNsfwVerdictRulings;
    expect(rulings).toHaveLength(5);
    expect(rulings[0].at).toBe('old-1');
    expect(rulings[4].ruling).toBe('dismiss');
  });

  // The revision the moderator's screen sends back: a ruling lands only on the lead it showed.
  const screen = () => currentRestrictedLeadRevision(dbMock.dbWrite as never, MODEL);
  const ruleSeen = (
    ruling: 'keep' | 'dismiss' | 'rateNsfw',
    revision: string | null,
    reason?: string
  ) =>
    resolveRestrictedNsfwVerdict({
      modelId: MODEL,
      ruling,
      reason,
      userId: MODERATOR,
      revision: revision ?? undefined,
    });
  const STALE = /changed since it was opened/;
  const scanRow = (level: number, reason: string) =>
    db.query(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", "triggeredLabels", result, "contentHash", "nsfwLevel")
       VALUES ('Model', $1, '{nsfw}', $2, 'h1', $3)
       ON CONFLICT ("entityType", "entityId") DO UPDATE SET result = $2, "nsfwLevel" = $3`,
      [MODEL, { labels: { nsfw: { reason } } }, level]
    );
  const expectRefusedKeepingLead = async (
    seen: string | null,
    ruling: 'keep' | 'dismiss' = 'keep'
  ) => {
    const before = (await row()).meta.restrictedNsfwVerdict;
    await expect(ruleSeen(ruling, seen, 'Escalated')).rejects.toThrow(STALE);
    expect((await row()).meta.restrictedNsfwVerdict).toEqual(before);
  };

  it('rules on the lead the moderator was shown when nothing has changed', async () => {
    await seed({ sfwOnly: true, meta: lead('sfwOnly') });
    await scanRow(16, 'explicit');
    await ruleSeen('dismiss', await screen());
    expect((await row()).meta).not.toHaveProperty('restrictedNsfwVerdict');
  });

  it('refuses once the owner unticks minor and the verdict applies', async () => {
    await seed({ minor: true, meta: lead('minor') });
    const seen = await screen();
    await db.query(`UPDATE "Model" SET minor = false WHERE id = $1`, [MODEL]);
    expect(await applyHeldRestrictedVerdict(MODEL)).toBe('applied');
    await expectRefusedKeepingLead(seen);
  });

  // Only the flag changes: the same lead waits for publish, but a Keep would now close it instead
  // of keeping it dormant.
  it('refuses once the owner unticks minor on a Private model', async () => {
    await seed({ minor: true, meta: lead('minor') });
    await db.query(`UPDATE "Model" SET availability = 'Private' WHERE id = $1`, [MODEL]);
    const seen = await screen();
    await db.query(`UPDATE "Model" SET minor = false WHERE id = $1`, [MODEL]);
    expect(await applyHeldRestrictedVerdict(MODEL)).toBe('held_restricted');
    expect((await row()).meta.restrictedNsfwVerdict).toEqual(lead('minor').restrictedNsfwVerdict);
    await expectRefusedKeepingLead(seen);
  });

  // The revived lead keeps its time; a screen from before the Keep must not rule on it again.
  it('refuses a screen opened before a Keep once the kept lead is revived', async () => {
    await seed({ minor: true, meta: lead('minor') });
    const seen = await screen();
    await ruleSeen('keep', seen);
    await db.query(`UPDATE "Model" SET minor = false, availability = 'Private' WHERE id = $1`, [
      MODEL,
    ]);
    expect(await applyHeldRestrictedVerdict(MODEL)).toBe('held_restricted');
    expect((await row()).meta.restrictedNsfwVerdict.at).toBe(
      lead('minor').restrictedNsfwVerdict.at
    );
    await expectRefusedKeepingLead(seen, 'dismiss');
  });

  it.each([
    ['a newer scan reads another level', () => scanRow(28, 'explicit')],
    ['a newer scan gives another reason', () => scanRow(16, 'graphic')],
  ])('refuses once %s, though the lead keeps its time', async (_, rescan) => {
    await seed({ sfwOnly: true, meta: lead('sfwOnly') });
    await scanRow(16, 'explicit');
    const seen = await screen();
    await rescan();
    await expectRefusedKeepingLead(seen, 'dismiss');
  });

  it('refuses once the forensics shown are from another scan', async () => {
    await seed({
      sfwOnly: true,
      meta: { ...lead('sfwOnly'), textModeration: { scannedAt: '2026-11-04T00:00:00.000Z' } },
    });
    const seen = await screen();
    await db.query(
      `UPDATE "Model" SET meta = jsonb_set(meta, '{textModeration,scannedAt}', '"2026-11-05T00:00:00.000Z"')
       WHERE id = $1`,
      [MODEL]
    );
    await expectRefusedKeepingLead(seen, 'dismiss');
  });

  it("refuses once a moderator's lock changes what Keep would do", async () => {
    await seed({ sfwOnly: true, meta: lead('sfwOnly') });
    const seen = await screen();
    await db.query(`UPDATE "Model" SET "lockedProperties" = '{nsfw}' WHERE id = $1`, [MODEL]);
    await expectRefusedKeepingLead(seen);
  });

  // Every field the revision covers, changed alone on a full row: each must change the revision.
  describe('the revision covers each field on its own', () => {
    const FULL = {
      restrictedNsfwVerdict: {
        source: 'text-scan',
        at: '2026-11-04T00:00:00.000Z',
        restriction: 'minor',
        liftedBy: 'moderator',
        applied: { at: '2026-11-05T00:00:00.000Z' },
      },
      restrictedNsfwVerdictRulings: [{ at: '2026-11-03T00:00:00Z' }],
      systemNsfwLock: { source: 'text-scan', at: '2026-11-05T00:00:00.000Z' },
      textModeration: { scannedAt: '2026-11-02T00:00:00.000Z' },
    };
    const set =
      (sql: string, ...params: unknown[]) =>
      () =>
        db.query(sql.replace('$MODEL', String(MODEL)), params);
    const meta = (path: string, value: unknown) =>
      set(`UPDATE "Model" SET meta = jsonb_set(meta, '{${path}}', $1::jsonb) WHERE id = $MODEL`, [
        JSON.stringify(value),
      ]);
    const scan = (column: string, value: unknown) =>
      set(`UPDATE "EntityModeration" SET ${column} = $1 WHERE "entityId" = $MODEL`, value);
    const model = (assignment: string) => set(`UPDATE "Model" SET ${assignment} WHERE id = $MODEL`);

    it.each([
      ['lead at', meta('restrictedNsfwVerdict,at', '2026-11-06T00:00:00.000Z')],
      ['lead source', meta('restrictedNsfwVerdict,source', 'profanity-filter')],
      ['lead restriction', meta('restrictedNsfwVerdict,restriction', 'poi')],
      ['lead liftedBy', meta('restrictedNsfwVerdict,liftedBy', 'appeal')],
      ['lead applied at', meta('restrictedNsfwVerdict,applied,at', '2026-11-06T00:00:00.000Z')],
      ['newest ruling', meta('restrictedNsfwVerdictRulings', [{ at: '2026-11-06T00:00:00Z' }])],
      ['minor', model('minor = NOT minor')],
      ['poi', model('poi = NOT poi')],
      ['Private', model(`availability = 'Private'`)],
      ['nsfw', model('nsfw = NOT nsfw')],
      ['sfwOnly', model('"sfwOnly" = NOT "sfwOnly"')],
      ['locks', model(`"lockedProperties" = '{sfwOnly,minor,nsfw}'`)],
      ['system lock at', meta('systemNsfwLock,at', '2026-11-06T00:00:00.000Z')],
      ['scan level', scan('"nsfwLevel"', 28)],
      ['scan labels', scan('"triggeredLabels"', ['nsfw'])],
      ['scan reason', scan('result', { labels: { nsfw: { reason: 'graphic' } } })],
      ['scan content hash', scan('"contentHash"', 'h2')],
      ['forensics time', meta('textModeration,scannedAt', '2026-11-06T00:00:00.000Z')],
    ])('%s', async (_, change) => {
      await seed({ sfwOnly: true, minor: true, locked: ['sfwOnly', 'minor'], meta: FULL });
      await db.query(
        `INSERT INTO "EntityModeration" ("entityType", "entityId", "triggeredLabels", result, "contentHash", "nsfwLevel")
         VALUES ('Model', $1, '{nsfw,violence}', $2, 'h1', 16)`,
        [MODEL, { labels: { nsfw: { reason: 'explicit' } } }]
      );
      const before = await screen();
      await change();
      expect(await screen()).not.toBe(before);
    });
  });

  // In the ruling's transaction, the row lock first, then the revision: never off the transaction.
  it('locks the model row, then reads the revision, all in the ruling transaction', async () => {
    await seed({ sfwOnly: true, meta: lead('sfwOnly') });
    const seen = await screen();
    vi.mocked(dbMock.dbWrite.$queryRaw).mockClear();
    vi.mocked(dbMock.dbRead.$queryRaw).mockClear();
    txReads.length = 0;
    await ruleSeen('dismiss', seen);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(txReads[0]).toMatch(/FOR UPDATE/);
    expect(txReads.findIndex((q) => q.includes('"EntityModeration"'))).toBeGreaterThan(0);
    expect((await row()).meta).not.toHaveProperty('restrictedNsfwVerdict');
  });

  // The endpoint's body and the ruling it makes: the revision must get through both.
  it('refuses through the endpoint a ruling whose revision is stale', async () => {
    await seed({ sfwOnly: true, meta: lead('sfwOnly') });
    const seen = await screen();
    await db.query(`UPDATE "Model" SET "lockedProperties" = '{nsfw}' WHERE id = $1`, [MODEL]);
    const body = resolveRestrictedNsfwVerdictInput.parse({
      modelId: MODEL,
      ruling: 'keep',
      revision: seen,
    });
    await expect(
      resolveRestrictedNsfwVerdict(restrictedNsfwRulingArgs(body, MODERATOR))
    ).rejects.toThrow(STALE);
  });

  it('gives a lead with no time a revision too, so the form always sends one', async () => {
    await seed({ sfwOnly: true, meta: { restrictedNsfwVerdict: { restriction: 'sfwOnly' } } });
    const seen = await screen();
    expect(seen).toMatch(/^[0-9a-f]{64}$/);
    await ruleSeen('dismiss', seen);
    expect((await row()).meta).not.toHaveProperty('restrictedNsfwVerdict');
  });

  // The same stored row as the moderator app's list test (restricted-nsfw-verdicts.pglite.test.ts):
  // both must read it into this revision.
  it('reads the stored row into the revision the moderator list gives', async () => {
    // Booleans that differ, so a field read into another's place is seen.
    await seed({
      sfwOnly: true,
      minor: true,
      locked: ['sfwOnly', 'minor'],
      meta: {
        restrictedNsfwVerdict: {
          source: 'text-scan',
          at: '2026-11-04T00:00:00.000Z',
          restriction: 'minor',
          liftedBy: 'moderator',
          applied: { at: '2026-11-05T00:00:00.000Z' },
        },
        restrictedNsfwVerdictRulings: [
          { at: '2026-11-01T00:00:00Z' },
          { at: '2026-11-03T00:00:00Z' },
        ],
        systemNsfwLock: { source: 'text-scan', at: '2026-11-05T00:00:00.000Z' },
        textModeration: { scannedAt: '2026-11-02T00:00:00.000Z' },
      },
    });
    await db.query(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", "triggeredLabels", result, "contentHash", "nsfwLevel")
       VALUES ('Model', $1, '{nsfw,violence}', $2, 'h1', 16)`,
      [MODEL, { labels: { nsfw: { reason: 'explicit' } } }]
    );
    await db.query(`UPDATE "Model" SET availability = 'Private' WHERE id = $1`, [MODEL]);
    expect(await screen()).toBe(
      restrictedLeadRevision({
        lead: {
          at: '2026-11-04T00:00:00.000Z',
          source: 'text-scan',
          restriction: 'minor',
          liftedBy: 'moderator',
          appliedAt: '2026-11-05T00:00:00.000Z',
        },
        lastRulingAt: '2026-11-03T00:00:00Z',
        model: {
          minor: true,
          poi: false,
          isPrivate: true,
          nsfw: false,
          sfwOnly: true,
          locks: ['minor', 'sfwOnly'],
          systemNsfwLockAt: '2026-11-05T00:00:00.000Z',
        },
        scan: {
          nsfwLevel: 16,
          triggeredLabels: ['violence', 'nsfw'],
          nsfwReason: 'explicit',
          contentHash: 'h1',
          forensicsScannedAt: '2026-11-02T00:00:00.000Z',
        },
      })
    );
  });

  it('refuses a second ruling on the same lead', async () => {
    await seed({ sfwOnly: true, meta: lead('sfwOnly') });
    await rule('dismiss');
    await expect(rule('keep')).rejects.toThrow(/ruled on meanwhile/);
    expect((await row()).meta.restrictedNsfwVerdictRulings).toHaveLength(1);
  });
});

describe('applyHeldRestrictedVerdict, after a save unticks minor or POI', () => {
  it.each([
    ['minor', true],
    ['minor', false],
    ['poi', true],
    ['poi', false],
  ] as const)(
    'applies a lead held as %s (SFW-only %s): nsfw on (unlocked), with what it replaced; Keep undoes it',
    async (restriction, sfwOnly) => {
      await seed({ sfwOnly, meta: { ...lead(restriction), other: 1 } });
      expect(await applyHeldRestrictedVerdict(MODEL)).toBe('applied');
      const after = await row();
      expect(after).toMatchObject({ nsfw: true, sfwOnly: false, lockedProperties: [] });
      expect(after.meta).toMatchObject({
        other: 1,
        systemNsfwLock: { source: 'text-scan', at: expect.any(String) },
        restrictedNsfwVerdict: {
          restriction,
          applied: {
            at: expect.any(String),
            prior: { nsfw: false, sfwOnly, lockedProperties: [], systemNsfwLock: null },
          },
        },
      });
      expect(after.meta.restrictedNsfwVerdictRulings).toEqual([
        expect.objectContaining({ ruling: 'autoApply', restriction }),
      ]);
      expect(mocks.trackModActivity).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({ entityId: MODEL, activity: 'restrictedNsfwVerdict:autoApply' })
      );

      await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling: 'keep', userId: MODERATOR });
      const kept = await row();
      expect(kept).toMatchObject({ nsfw: false, sfwOnly, lockedProperties: [] });
      expect(kept.meta).not.toHaveProperty('systemNsfwLock');
      expect(kept.meta).not.toHaveProperty('restrictedNsfwVerdict');
    }
  );

  it.each(['minor', 'poi'] as const)(
    'leaves the lead held while the model is still %s',
    async (flag) => {
      await seed({ [flag]: true, meta: lead(flag) });
      expect(await applyHeldRestrictedVerdict(MODEL)).toBeNull();
      const after = await row();
      expect(after).toMatchObject({ nsfw: false, lockedProperties: [] });
      expect(after.meta.restrictedNsfwVerdict).not.toHaveProperty('applied');
    }
  );

  it('writes nothing once a moderator ruled on the lead after it was read', async () => {
    await seed({});
    expect(
      await applySystemModelNsfwFlag({ model: scanned(), source: 'text-scan', heldLead: true })
    ).toBe('declined_race');
    await seed({
      meta: { restrictedNsfwVerdict: { ...lead('poi').restrictedNsfwVerdict, applied: {} } },
    });
    expect(
      await applySystemModelNsfwFlag({ model: scanned(), source: 'text-scan', heldLead: true })
    ).toBe('declined_race');
    expect(await row()).toMatchObject({ nsfw: false, lockedProperties: [] });
  });

  it("keep after the owner re-ticks minor leaves the flag's locks and SFW-only", async () => {
    await seed({ meta: lead('minor') });
    expect(await applyHeldRestrictedVerdict(MODEL)).toBe('applied');
    // The re-tick: the minor flag forces the rating off and locks it.
    await db.query(
      `UPDATE "Model" SET minor = true, "sfwOnly" = true, nsfw = false,
         "lockedProperties" = ARRAY['nsfw', 'minor', 'sfwOnly'] WHERE id = $1`,
      [MODEL]
    );
    await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling: 'keep', userId: MODERATOR });
    const after = await row();
    expect(after).toMatchObject({
      nsfw: false,
      sfwOnly: true,
      lockedProperties: ['nsfw', 'minor', 'sfwOnly'],
    });
    expect(after.meta).not.toHaveProperty('restrictedNsfwVerdict');
  });

  it('does nothing without a lead', async () => {
    await seed({});
    expect(await applyHeldRestrictedVerdict(MODEL)).toBeNull();
    expect(await row()).toMatchObject({ nsfw: false, lockedProperties: [] });
  });

  it('applies a lifted lead once the owner unticks a flag set again since', async () => {
    const held = { ...lead('minor').restrictedNsfwVerdict, liftedBy: 'moderator' };
    await seed({ sfwOnly: true, meta: { restrictedNsfwVerdict: held } });
    expect(await applyHeldRestrictedVerdict(MODEL, { ownerCleared: true })).toBe('applied');
    const after = await row();
    expect(after).toMatchObject({ nsfw: true, lockedProperties: [] });
    expect(after.meta.restrictedNsfwVerdict).not.toHaveProperty('liftedBy');
  });

  it.each(['moderator', 'hashRevert'] as const)(
    'leaves a lead whose flag was lifted by %s for a moderator to rule on',
    async (liftedBy) => {
      const held = { ...lead('minor').restrictedNsfwVerdict, liftedBy };
      await seed({ sfwOnly: true, meta: { restrictedNsfwVerdict: held } });
      expect(await applyHeldRestrictedVerdict(MODEL)).toBeNull();
      const after = await row();
      expect(after).toMatchObject({ nsfw: false, lockedProperties: [] });
      expect(after.meta.restrictedNsfwVerdict).toEqual(held);
    }
  );
});

describe('a Private model, which must stay SFW-only', () => {
  const makePrivate = () =>
    db.query(`UPDATE "Model" SET availability = 'Private' WHERE id = $1`, [MODEL]);
  const publish = async () => {
    await db.query(`UPDATE "Model" SET availability = 'Public' WHERE id = $1`, [MODEL]);
    return applyHeldVerdictLeavingPrivate(dbMock.dbWrite as never, MODEL);
  };
  const expectHeld = async () => {
    const after = await row();
    expect(after).toMatchObject({ nsfw: false, sfwOnly: true, lockedProperties: [] });
    expect(after.meta.restrictedNsfwVerdict).toBeDefined();
    expect(after.meta.restrictedNsfwVerdict).not.toHaveProperty('applied');
    expect(after.meta).not.toHaveProperty('systemNsfwLock');
  };
  const expectApplied = async () => {
    const after = await row();
    expect(after).toMatchObject({ nsfw: true, sfwOnly: false, lockedProperties: [] });
    expect(after.meta.systemNsfwLock).toMatchObject({ source: 'text-scan' });
    expect(after.meta.restrictedNsfwVerdict.applied.prior).toMatchObject({
      nsfw: false,
      sfwOnly: true,
    });
    expect(after.meta.restrictedNsfwVerdictRulings.at(-1)).toMatchObject({ ruling: 'autoApply' });
    expect(mocks.trackModActivity).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ entityId: MODEL, activity: 'restrictedNsfwVerdict:autoApply' }),
      dbMock.dbWrite
    );
  };

  it.each(['minor', 'poi'] as const)(
    'an owner untick of %s with a lead held keeps it held; it applies when published',
    async (restriction) => {
      await seed({ sfwOnly: true, meta: lead(restriction) });
      await makePrivate();
      expect(await applyHeldRestrictedVerdict(MODEL)).toBe('held_restricted');
      await expectHeld();
      expect(await publish()).toBe(true);
      await expectApplied();
    }
  );

  // Every source but the text scan keeps the lock, as before this change: here the profanity filter.
  it('applies a held profanity-filter lead with the nsfw lock and its marker', async () => {
    await seed({
      sfwOnly: true,
      meta: {
        restrictedNsfwVerdict: {
          source: 'profanity-filter',
          at: '2026-11-04T00:00:00.000Z',
          restriction: 'minor',
        },
      },
    });
    await makePrivate();
    await applyHeldRestrictedVerdict(MODEL);
    expect(await publish()).toBe(true);
    const after = await row();
    expect(after).toMatchObject({ nsfw: true, lockedProperties: ['nsfw'] });
    expect(after.meta.systemNsfwLock).toMatchObject({ source: 'profanity-filter' });
  });

  it('applies a held lead with no source with the nsfw lock', async () => {
    await seed({
      sfwOnly: true,
      meta: { restrictedNsfwVerdict: { at: '2026-11-04T00:00:00.000Z', restriction: 'minor' } },
    });
    await makePrivate();
    await applyHeldRestrictedVerdict(MODEL);
    expect(await publish()).toBe(true);
    expect(await row()).toMatchObject({ nsfw: true, lockedProperties: ['nsfw'] });
  });

  it('the scan on a model that went Private between submit and callback holds the verdict', async () => {
    await seed({ sfwOnly: true });
    await makePrivate();
    expect(
      await applySystemModelNsfwFlag({ model: scanned({ sfwOnly: true }), source: 'text-scan' })
    ).toBe('held_restricted');
    await expectHeld();
    expect((await row()).meta.restrictedNsfwVerdict.restriction).toBe('sfwOnly');
  });

  it('applies once: a second publish and a rescan leave it as it is', async () => {
    await seed({ sfwOnly: true, meta: lead('minor') });
    await makePrivate();
    await applyHeldRestrictedVerdict(MODEL);
    expect(await publish()).toBe(true);
    const applied = (await row()).meta;
    expect(await applyHeldVerdictLeavingPrivate(dbMock.dbWrite as never, MODEL)).toBe(false);
    expect(await applyHeldRestrictedVerdict(MODEL)).toBeNull();
    expect(
      await applySystemModelNsfwFlag({
        model: scanned({ nsfw: true, lockedProperties: ['nsfw'] }),
        source: 'text-scan',
      })
    ).not.toBe('applied');
    const after = await row();
    expect(after).toMatchObject({ nsfw: true, lockedProperties: [] });
    expect(after.meta).toEqual(applied);
  });

  it('a lifted lead the owner unticks again on a Private model applies at publish', async () => {
    const held = { ...lead('minor').restrictedNsfwVerdict, liftedBy: 'moderator' };
    await seed({ sfwOnly: true, meta: { restrictedNsfwVerdict: held } });
    await makePrivate();
    expect(await applyHeldRestrictedVerdict(MODEL, { ownerCleared: true })).toBe('held_restricted');
    expect(await publish()).toBe(true);
    await expectApplied();
  });

  it('a lead whose flag a moderator lifted stays held at publish', async () => {
    const held = { ...lead('minor').restrictedNsfwVerdict, liftedBy: 'moderator' };
    await seed({ sfwOnly: true, meta: { restrictedNsfwVerdict: held } });
    await makePrivate();
    expect(await publish()).toBe(false);
    await expectHeld();
  });

  it('a new scan verdict on a lifted lead applies at publish', async () => {
    const held = { ...lead('minor').restrictedNsfwVerdict, liftedBy: 'moderator' };
    await seed({ sfwOnly: true, meta: { restrictedNsfwVerdict: held } });
    await makePrivate();
    expect(
      await applySystemModelNsfwFlag({
        model: scanned({ availability: 'Private' }),
        source: 'text-scan',
      })
    ).toBe('held_restricted');
    expect((await row()).meta.restrictedNsfwVerdict).not.toHaveProperty('liftedBy');
    expect(await publish()).toBe(true);
    await expectApplied();
  });

  it('publishing with no lead changes nothing (control)', async () => {
    await seed({ sfwOnly: true });
    await makePrivate();
    expect(await publish()).toBe(false);
    expect(await row()).toMatchObject({ nsfw: false, sfwOnly: true, lockedProperties: [] });
  });

  it('a verdict kept while minor revives on the untick and applies when published', async () => {
    await seed({ minor: true, meta: lead('minor') });
    await makePrivate();
    await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling: 'keep', userId: MODERATOR });
    await db.query(`UPDATE "Model" SET minor = false WHERE id = $1`, [MODEL]);
    expect(await applyHeldRestrictedVerdict(MODEL)).toBe('held_restricted');
    await expectHeld();
    expect(await publish()).toBe(true);
    await expectApplied();
  });

  it('a kept verdict still dormant at publish (the flag cleared by another path) applies then', async () => {
    await seed({ minor: true, meta: lead('minor') });
    await makePrivate();
    await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling: 'keep', userId: MODERATOR });
    await db.query(`UPDATE "Model" SET minor = false WHERE id = $1`, [MODEL]);
    expect((await row()).meta).toHaveProperty('restrictedNsfwVerdictDormant');
    expect(await publish()).toBe(true);
    await expectApplied();
    expect((await row()).meta).not.toHaveProperty('restrictedNsfwVerdictDormant');
  });

  it('refuses Rate NSFW on a Private model; Keep closes the lead', async () => {
    await seed({ sfwOnly: true });
    await makePrivate();
    await applySystemModelNsfwFlag({ model: scanned({ sfwOnly: true }), source: 'text-scan' });
    await expect(
      resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling: 'rateNsfw', userId: MODERATOR })
    ).rejects.toThrow(/applies when it is published/);
    await expectHeld();
    await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling: 'keep', userId: MODERATOR });
    expect((await row()).meta).not.toHaveProperty('restrictedNsfwVerdict');
    expect(await publish()).toBe(false);
  });

  it("holds on a moderator's SFW-only lock too", async () => {
    await seed({ sfwOnly: true, locked: ['sfwOnly'] });
    expect(
      await applySystemModelNsfwFlag({
        model: scanned({ sfwOnly: true, lockedProperties: ['sfwOnly'] }),
        source: 'text-scan',
      })
    ).toBe('held_restricted');
    expect(await row()).toMatchObject({
      nsfw: false,
      sfwOnly: true,
      lockedProperties: ['sfwOnly'],
    });
  });

  it('a Public SFW-only model is still rated at once (control)', async () => {
    await seed({ sfwOnly: true });
    expect(
      await applySystemModelNsfwFlag({ model: scanned({ sfwOnly: true }), source: 'text-scan' })
    ).toBe('applied');
    expect(await row()).toMatchObject({ nsfw: true, sfwOnly: false });
  });
});

describe("a lead from the owner's flag over the scan's rating", () => {
  const override = {
    at: '2026-11-02T00:00:00.000Z',
    flags: ['minor'],
    prevNsfw: true,
    prevSfwOnly: false,
    prevLockedProperties: ['nsfw'],
    prevGalleryLevel: 1,
  };

  it.each([
    ['keep', undefined],
    ['dismiss', 'Checked the gallery'],
  ] as const)(
    '%s settles the flag record, so a later lift restores nothing',
    async (ruling, reason) => {
      await seed({
        minor: true,
        locked: ['nsfw', 'minor', 'sfwOnly'],
        meta: { systemNsfwLock: SYSTEM_LOCK, ownerFlagOverride: override, ...lead('minor') },
      });
      const before = await row();
      expect(before.meta).toHaveProperty('ownerFlagOverride');
      await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling, reason, userId: MODERATOR });
      const after = await row();
      expect(after.meta).not.toHaveProperty('ownerFlagOverride');
      expect(after.meta).not.toHaveProperty('restrictedNsfwVerdict');
      expect(after.nsfw).toBe(false);
    }
  );

  it('keeps an earlier declaration and its time, adding the flags the override lists', async () => {
    const earlier = { at: '2026-10-01T00:00:00.000Z', flags: ['poi'] };
    await seed({
      minor: true,
      locked: ['nsfw', 'minor', 'sfwOnly'],
      meta: {
        systemNsfwLock: SYSTEM_LOCK,
        ownerFlagOverride: override,
        ownerDeclaredFlags: earlier,
        ...lead('minor'),
      },
    });
    await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling: 'keep', userId: MODERATOR });
    expect((await row()).meta.ownerDeclaredFlags).toEqual({
      at: earlier.at,
      flags: ['poi', 'minor'],
    });
  });

  it.each([
    ['keep', undefined],
    ['dismiss', 'Checked the gallery'],
  ] as const)(
    'after %s, a hash rollback from an old snapshot still sees the owner declared minor',
    async (ruling, reason) => {
      // An old snapshot: no prevMinor, no minor lock, and a rating no minor flag leaves.
      const oldSnapshot = {
        at: '2026-10-01T00:00:00.000Z',
        source: 'auto',
        prevNsfw: true,
        prevSfwOnly: false,
        prevLockedProperties: ['nsfw'],
      };
      await seed({
        minor: true,
        locked: ['nsfw', 'minor', 'sfwOnly'],
        meta: {
          systemNsfwLock: SYSTEM_LOCK,
          ownerFlagOverride: override,
          minorFlagSnapshot: oldSnapshot,
          ...lead('minor'),
        },
      });
      const rollback = () =>
        rollbackMinorHashAutoFlags({ dryRun: true, limit: 1, modelIds: [MODEL] });
      expect((await rollback()).keptMinor).toBe(1);
      await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling, reason, userId: MODERATOR });
      expect((await row()).meta.ownerDeclaredFlags.flags).toEqual(['minor']);
      expect((await row()).meta.ownerDeclaredFlags.at).toBe(override.at);
      expect(await rollback()).toMatchObject({ keptMinor: 1, rolledBack: 0 });
    }
  );
});

describe('a stuck minor or POI model whose scan lock time cannot be read', () => {
  it.each(['minor', 'poi'] as const)(
    '%s: Keep still ends it SFW; Dismiss is refused',
    async (flag) => {
      await seed({
        nsfw: true,
        [flag]: true,
        sfwOnly: false,
        locked: ['nsfw'],
        meta: { systemNsfwLock: { source: 'text-scan', at: 'bad' }, ...lead(flag) },
      });
      const before = await row();
      await expect(
        resolveRestrictedNsfwVerdict({
          modelId: MODEL,
          ruling: 'dismiss',
          reason: 'x',
          userId: MODERATOR,
        })
      ).rejects.toThrow(/can't be saved as it is/);
      expect(await row()).toEqual(before);
      await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling: 'keep', userId: MODERATOR });
      const after = await row();
      expect(after.nsfw).toBe(false);
      expect(after.meta).not.toHaveProperty('restrictedNsfwVerdict');
    }
  );
});

describe('Dismiss on a model left NSFW and SFW-only', () => {
  it('is refused; Keep and Rate NSFW still resolve it', async () => {
    for (const ruling of ['keep', 'rateNsfw'] as const) {
      // A model stuck before this change, as the backfill stamps it.
      await seed({
        nsfw: true,
        sfwOnly: true,
        locked: ['nsfw'],
        meta: { systemNsfwLock: SYSTEM_LOCK, ...lead('sfwOnly') },
      });
      await expect(
        resolveRestrictedNsfwVerdict({
          modelId: MODEL,
          ruling: 'dismiss',
          reason: 'x',
          userId: MODERATOR,
        })
      ).rejects.toThrow(/can't be saved as it is/);
      expect((await row()).meta).toHaveProperty('restrictedNsfwVerdict');
      await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling, userId: MODERATOR });
      const after = await row();
      expect(after.meta).not.toHaveProperty('restrictedNsfwVerdict');
      expect(after.nsfw && after.sfwOnly).toBe(false);
      expect(mocks.updateModelNsfwLevels).toHaveBeenLastCalledWith([MODEL]);
    }
  });
});

describe('a lead kept while the model is still minor or POI', () => {
  it.each(['minor', 'poi'] as const)(
    'Keep, then the owner unticks %s: the verdict is applied and back in the queue',
    async (flag) => {
      await seed({ [flag]: true, meta: lead(flag) });
      await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling: 'keep', userId: MODERATOR });
      const kept = await row();
      expect(kept).toMatchObject({ nsfw: false, sfwOnly: true });
      expect(kept.meta).not.toHaveProperty('restrictedNsfwVerdict');
      expect(kept.meta.restrictedNsfwVerdictDormant).toEqual(lead(flag).restrictedNsfwVerdict);

      // The untick save.
      await db.query(`UPDATE "Model" SET minor = false, poi = false WHERE id = $1`, [MODEL]);
      expect(await applyHeldRestrictedVerdict(MODEL)).toBe('applied');
      const after = await row();
      expect(after).toMatchObject({ nsfw: true, sfwOnly: false, lockedProperties: [] });
      expect(after.meta).not.toHaveProperty('restrictedNsfwVerdictDormant');
      expect(after.meta.restrictedNsfwVerdict).toMatchObject({
        restriction: flag,
        applied: { prior: { nsfw: false, sfwOnly: true } },
      });
      expect(
        after.meta.restrictedNsfwVerdictRulings.map((r: { ruling: string }) => r.ruling)
      ).toEqual(['keep', 'autoApply']);
    }
  );

  it('stays dormant while the flag is still ticked', async () => {
    await seed({ minor: true, meta: lead('minor') });
    await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling: 'keep', userId: MODERATOR });
    expect(await applyHeldRestrictedVerdict(MODEL)).toBeNull();
    expect((await row()).meta).toHaveProperty('restrictedNsfwVerdictDormant');
  });

  it('Dismiss keeps nothing: an untick applies nothing', async () => {
    await seed({ minor: true, meta: lead('minor') });
    await resolveRestrictedNsfwVerdict({
      modelId: MODEL,
      ruling: 'dismiss',
      reason: 'Escalated in Auto-flagged',
      userId: MODERATOR,
    });
    const dismissed = await row();
    expect(dismissed.meta).not.toHaveProperty('restrictedNsfwVerdictDormant');
    expect(dismissed.meta.restrictedNsfwVerdictRulings.at(-1)).toMatchObject({
      ruling: 'dismiss',
      reason: 'Escalated in Auto-flagged',
    });
    await db.query(`UPDATE "Model" SET minor = false, "sfwOnly" = false WHERE id = $1`, [MODEL]);
    expect(await applyHeldRestrictedVerdict(MODEL)).toBeNull();
    expect(await row()).toMatchObject({ nsfw: false, lockedProperties: [] });
  });

  it('a later Dismiss on a new lead drops the kept verdict too', async () => {
    await seed({ minor: true, meta: lead('minor') });
    await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling: 'keep', userId: MODERATOR });
    expect(
      await applySystemModelNsfwFlag({ model: scanned({ minor: true }), source: 'text-scan' })
    ).toBe('held_restricted');
    await resolveRestrictedNsfwVerdict({
      modelId: MODEL,
      ruling: 'dismiss',
      reason: 'Escalated to CSAM tools',
      userId: MODERATOR,
    });
    expect((await row()).meta).not.toHaveProperty('restrictedNsfwVerdictDormant');
  });

  it('Keep on an unrestricted model keeps nothing dormant', async () => {
    await seed({ sfwOnly: true, meta: lead('sfwOnly') });
    await resolveRestrictedNsfwVerdict({ modelId: MODEL, ruling: 'keep', userId: MODERATOR });
    expect((await row()).meta).not.toHaveProperty('restrictedNsfwVerdictDormant');
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
    // A malformed lock time must not abort the run; with a moderator activity on record it is skipped.
    await insert(7, {
      sfwOnly: true,
      meta: { systemNsfwLock: { source: 'text-scan', at: 'bad' } },
    });
    await db.query(
      `INSERT INTO "ModActivity" (activity, "entityType", "entityId") VALUES ('setSfwOnly', 'model', 7)`
    );

    expect((await db.query<{ to_backfill: number }>(dryRun)).rows[0].to_backfill).toBe(2);
    await db.exec('BEGIN');
    const statements = write.split(/;\s*$/m).filter((s) => s.trim());
    const result = await db.query<{ backfilled: number; ids: number[] }>(statements[0]);
    expect(result.rows[0]).toEqual({ backfilled: 2, ids: [1, 2] });
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
      { id: 7, lead: null },
    ]);
    // Nothing but the lead changed.
    expect((await db.query(`SELECT count(*)::int AS n FROM "Model" WHERE nsfw`)).rows[0]).toEqual({
      n: 7,
    });
  });
});

describe("a moderator lifting a model's SFW-only lock", () => {
  it('leaves the lead the lock held waiting for a ruling, not for the owner to apply', async () => {
    await seed({ meta: lead('sfwOnly') });
    await holdLeadAfterSfwOnlyLift(dbMock.dbWrite as never, MODEL);
    expect((await row()).meta.restrictedNsfwVerdict).toMatchObject({ liftedBy: 'moderator' });
    expect(await applyHeldRestrictedVerdict(MODEL)).toBeNull();
    expect(await row()).toMatchObject({ nsfw: false, lockedProperties: [] });
  });

  it('leaves the lead alone while a minor flag still holds the rating', async () => {
    await seed({ minor: true, meta: lead('sfwOnly') });
    await holdLeadAfterSfwOnlyLift(dbMock.dbWrite as never, MODEL);
    expect((await row()).meta.restrictedNsfwVerdict).not.toHaveProperty('liftedBy');
  });
});
