import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { bootLabelStore } from '~/server/services/__tests__/label-store.fixture';
import type { TextScanFlags } from '~/server/services/text-scan/flag-snapshot';
import type * as ModeModule from '~/server/services/text-scan/mode';

// Runs the flag writers and the two decision services that call them on real Postgres with the committed migration.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const db = dbMock.dbWrite;
// Prisma sends these as typed text; Postgres cannot infer them as bare `$n` from `->` or
// jsonb_build_object, so the harness casts them.
const run = async (strings: TemplateStringsArray, values: unknown[]) => {
  const { text, values: params } = Prisma.sql(strings, ...(values as never[]));
  const typed = text
    .replace(/->\$(\d+)(?!\d)/g, '->$$$1::text')
    .replace(/jsonb_build_object\(\s*\$(\d+),/g, 'jsonb_build_object($$$1::text,');
  return holder.db.query(typed, params as unknown[]);
};
db.$executeRaw.mockImplementation(
  (async (s: TemplateStringsArray, ...v: unknown[]) => (await run(s, v)).affectedRows ?? 0) as never
);
db.$queryRaw.mockImplementation(
  (async (s: TemplateStringsArray, ...v: unknown[]) => (await run(s, v)).rows) as never
);
// A real transaction, so a failure inside one rolls the decision back as it would in production.
db.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) => {
  await holder.db.exec('BEGIN');
  try {
    const result = await fn(db);
    await holder.db.exec('COMMIT');
    return result;
  } catch (error) {
    await holder.db.exec('ROLLBACK');
    throw error;
  }
}) as never);
db.model.findUnique.mockImplementation(
  (async ({ where }: { where: { id: number } }) =>
    (await holder.db.query(`SELECT * FROM "Model" WHERE id = $1`, [where.id])).rows[0] ??
    null) as never
);
db.appeal.findFirst.mockResolvedValue(null as never);
db.entityModeration.findUnique.mockResolvedValue(null as never);

vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanWebSearchMode: async () => 'off',
  getTextScanLabelMode: async () => 'auto',
}));
vi.mock('~/server/services/model.service', () => ({
  MINOR_FLAG_SNAPSHOT_KEY: 'minorFlagSnapshot',
  setModelMinor: vi.fn(),
  applyModelFlagSideEffects: vi.fn(),
  clearPoiHashMeta: vi.fn(),
  restoreOwnerFlagOverride: vi.fn(),
}));
vi.mock('~/server/services/minor-hash.service', () => ({
  confirmMinorHashAutoFlag: vi.fn(),
  revertMinorHashAutoFlag: vi.fn(),
}));
vi.mock('~/server/services/report.service', () => ({ resolveEntityAppeal: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({
  bustPublicModelResponseCache: vi.fn(),
}));
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateModelNsfwLevels: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/clickhouse/tracker', () => ({
  Tracker: class {
    entityChanges = vi.fn().mockResolvedValue(undefined);
  },
}));
const CURRENT = { fields: [{ heading: 'Name', text: 'the scanned model text' }], declared: {} };
vi.mock('~/server/services/text-scan/profiles', () => ({
  getTextScanProfile: () => ({
    load: async (ids: number[]) => new Map(ids.map((id) => [id, CURRENT])),
  }),
}));
vi.mock('~/server/services/text-scan/profiles/index', () => ({}));

const { grantModelTextScanPoi, stampModelTextScanAppeal } = await import(
  '~/server/services/text-scan/actions/model-poi-minor'
);
const { stampModeratorTextScanRuling } = await import(
  '~/server/services/text-scan/actions/appeal-text-hash'
);
const { resolveTextScanRedetection } = await import(
  '~/server/services/text-scan/actions/redetection'
);
const { ruleModelTextScanFlag } = await import('~/server/services/text-scan/actions/flag-ruling');
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');

const MODEL = 7;
const OWNER = 42;
const MOD = 9;
const SCANNED = textScanTextHash(CURRENT as never);
const NEWER = 'hash-newer';

const verdict = { at: 'x', workflowId: 'wf-1', reason: 'verdict reason', textHash: SCANNED };

async function seed({
  minor = false,
  poi = false,
  flags,
}: {
  minor?: boolean;
  poi?: boolean;
  flags: Record<string, unknown>;
}) {
  await holder.db.exec(`
    TRUNCATE label_store.subject, label_store.change, label_store.record_failure,
      label_store.erased_subject, label_store.erased_owner RESTART IDENTITY CASCADE;
    TRUNCATE "Model", "EntityModeration";
  `);
  await holder.db.query(
    `INSERT INTO "Model" (id, name, "userId", status, minor, poi, "lockedProperties", meta)
     VALUES ($1, 'm', $2, 'Published', $3, $4, $5, $6)`,
    [MODEL, OWNER, minor, poi, poi ? ['poi'] : [], JSON.stringify({ textScanFlags: flags })]
  );
}

type Label = {
  question: string;
  value: string;
  labellerKind: string;
  reason: string | null;
  reasonNote: string | null;
  contentHash: string;
  snapshot: Record<string, unknown>;
};
const labels = async () =>
  (
    await holder.db.query<Label>(
      `SELECT l.question, l.value, l."labellerKind", l.reason, l."reasonNote", s."contentHash", s.snapshot
       FROM label_store.label l JOIN label_store.subject s ON s.id = l."subjectId" ORDER BY l.id`
    )
  ).rows;
const model = async () =>
  (
    await holder.db.query<{ minor: boolean; poi: boolean; meta: { textScanFlags: TextScanFlags } }>(
      `SELECT minor, poi, meta FROM "Model" WHERE id = $1`,
      [MODEL]
    )
  ).rows[0];

beforeAll(async () => {
  holder.db = await PGlite.create();
  await bootLabelStore(holder.db);
  await holder.db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, name text, description text, "userId" int, status text,
      minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
      nsfw boolean NOT NULL DEFAULT false, "sfwOnly" boolean NOT NULL DEFAULT false,
      "gallerySettings" jsonb, "lockedProperties" text[] NOT NULL DEFAULT '{}', meta jsonb
    );
    CREATE TABLE "EntityModeration" (
      "entityType" text, "entityId" int, "workflowId" text, result jsonb,
      PRIMARY KEY ("entityType", "entityId")
    );
  `);
});

afterAll(async () => {
  await holder.db.close();
});

beforeEach(() => {
  redisMock.sysRedis.set.mockResolvedValue('OK' as never);
  redisMock.sysRedis.eval.mockResolvedValue(1 as never);
});

describe('a moderator ruling on a text-scan model flag is recorded as a label', () => {
  it('rule keep: the flag stands', async () => {
    await seed({ minor: true, flags: { minor: verdict } });

    await ruleModelTextScanFlag({
      modelId: MODEL,
      label: 'minor',
      keep: true,
      textHash: SCANNED,
      userId: MOD,
      reason: 'reason-slug',
      note: 'a note',
    });

    expect(await labels()).toEqual([
      {
        question: 'text_scan.model.minor',
        value: 'flag',
        labellerKind: 'moderator',
        reason: 'reason-slug',
        reasonNote: 'a note',
        contentHash: SCANNED,
        snapshot: {
          text: '## Name\nthe scanned model text',
          textHash: SCANNED,
          workflowId: 'wf-1',
          verdictReason: 'verdict reason',
        },
      },
    ]);
  });

  it('rule lift: a real-person flag is cleared', async () => {
    await seed({ poi: true, flags: { poi: { ...verdict, prev: { nsfw: false } } } });

    await ruleModelTextScanFlag({
      modelId: MODEL,
      label: 'poi',
      keep: false,
      textHash: SCANNED,
      userId: MOD,
    });

    expect((await model()).poi).toBe(false);
    expect(await labels()).toMatchObject([
      { question: 'text_scan.model.poi', value: 'clear', labellerKind: 'moderator' },
    ]);
  });

  it('rule lift: a minor flag is cleared', async () => {
    await seed({ minor: true, flags: { minor: verdict } });

    await ruleModelTextScanFlag({
      modelId: MODEL,
      label: 'minor',
      keep: false,
      textHash: SCANNED,
      userId: MOD,
    });

    expect(await labels()).toMatchObject([
      { question: 'text_scan.model.minor', value: 'clear', labellerKind: 'moderator' },
    ]);
  });

  it('confirm: signs the minor flag off as a moderator keep', async () => {
    await seed({ minor: true, flags: { minor: verdict } });

    await stampModelTextScanAppeal({
      modelId: MODEL,
      userId: MOD,
      decision: 'appealUpheld',
      labels: ['minor'],
      via: 'moderator',
    });

    expect(await labels()).toMatchObject([{ value: 'flag', labellerKind: 'moderator' }]);
  });

  it('revert and unset: a moderator lift on the current text', async () => {
    await seed({ flags: { minor: verdict } });

    await stampModeratorTextScanRuling({ modelId: MODEL, userId: MOD, label: 'minor' });

    expect(await labels()).toMatchObject([
      { value: 'clear', labellerKind: 'moderator', contentHash: SCANNED },
    ]);
  });

  it("resolve appeal: rulings on the owner's appeal are appeal outcomes, per label", async () => {
    await seed({ minor: true, poi: true, flags: { minor: verdict, poi: verdict } });

    await stampModelTextScanAppeal({
      modelId: MODEL,
      userId: MOD,
      decision: 'appealUpheld',
      labels: ['minor'],
    });
    await grantModelTextScanPoi({ modelId: MODEL, userId: MOD, grantHash: SCANNED });

    expect(await labels()).toMatchObject([
      { question: 'text_scan.model.minor', value: 'flag', labellerKind: 'appeal' },
      { question: 'text_scan.model.poi', value: 'clear', labellerKind: 'appeal' },
    ]);
  });

  it('resolve appeal: a grant covers the text the moderator reviewed', async () => {
    await seed({ minor: true, flags: { minor: verdict } });

    await stampModelTextScanAppeal({
      modelId: MODEL,
      userId: MOD,
      decision: 'appealGranted',
      labels: ['minor'],
      grantHashes: { minor: NEWER },
    });

    const [label] = await labels();
    expect(label).toMatchObject({ value: 'clear', contentHash: NEWER });
    expect(label.snapshot).not.toHaveProperty('text');
  });

  describe('resolve re-detection', () => {
    const held = {
      kind: 'redetected',
      workflowId: 'wf-held',
      reason: 'held reason',
      textHash: SCANNED,
      promptIds: { base: 3 },
    };
    const granted = { ...verdict, textHash: 'hash-older', appealGranted: { at: 'x', by: 1 } };

    it("keep records a flag on the held text with the held detection's verdict", async () => {
      await seed({ flags: { minor: { ...granted, redetected: held } } });
      await holder.db.query(`INSERT INTO "EntityModeration" VALUES ('Model', $1, 'wf-other', $2)`, [
        MODEL,
        JSON.stringify({ version: 1, promptIds: { base: 99 } }),
      ]);

      expect(
        await resolveTextScanRedetection({
          modelId: MODEL,
          label: 'minor',
          keep: true,
          textHash: SCANNED,
          userId: MOD,
        })
      ).toBe('kept');

      expect(await labels()).toEqual([
        expect.objectContaining({
          value: 'flag',
          labellerKind: 'moderator',
          contentHash: SCANNED,
          snapshot: expect.objectContaining({
            workflowId: 'wf-held',
            promptIds: { base: 3 },
            verdictReason: 'held reason',
          }),
        }),
      ]);
    });

    it("dismiss records a clear on the held text with the held detection's verdict", async () => {
      await seed({ flags: { minor: { ...granted, redetected: held } } });

      expect(
        await resolveTextScanRedetection({
          modelId: MODEL,
          label: 'minor',
          keep: false,
          textHash: SCANNED,
          userId: MOD,
          reason: 'dismiss-slug',
        })
      ).toBe('dismissed');

      expect(await labels()).toEqual([
        expect.objectContaining({
          value: 'clear',
          labellerKind: 'moderator',
          reason: 'dismiss-slug',
          contentHash: SCANNED,
          snapshot: expect.objectContaining({
            workflowId: 'wf-held',
            promptIds: { base: 3 },
            verdictReason: 'held reason',
          }),
        }),
      ]);
    });

    it('a dismissal that lands on nothing records nothing', async () => {
      await seed({ flags: { minor: { ...granted, redetected: { ...held, textHash: NEWER } } } });
      db.model.findUnique.mockResolvedValueOnce({
        minor: false,
        poi: false,
        meta: { textScanFlags: { minor: { ...granted, redetected: held } } },
      } as never);

      await expect(
        resolveTextScanRedetection({
          modelId: MODEL,
          label: 'minor',
          keep: false,
          textHash: SCANNED,
          userId: MOD,
        })
      ).rejects.toThrow('This re-detection changed or was already resolved');

      expect(await labels()).toEqual([]);
    });
  });

  it('records nothing for a real-person lift that lands on nothing', async () => {
    // An earlier grant is on the flag: a refused lift must not record it again as this ruling.
    await seed({
      poi: true,
      flags: { poi: { ...verdict, appealGranted: { at: 'x', by: 1, textHash: SCANNED } } },
    });

    expect(
      await grantModelTextScanPoi({
        modelId: MODEL,
        userId: MOD,
        grantHash: SCANNED,
        via: 'moderator',
        expectTextHash: 'another-hash',
      })
    ).toBe(false);

    expect(await labels()).toEqual([]);
  });

  it('records nothing for a flag with no text-scan verdict', async () => {
    await seed({ flags: { minor: { appealGranted: { at: 'x', by: 1 } } } });

    await stampModeratorTextScanRuling({ modelId: MODEL, userId: MOD, label: 'minor' });

    expect(await labels()).toEqual([]);
  });

  it('records nothing when the ruling wrote nothing', async () => {
    // An earlier keep is on the flag: a refused write must not record it again as this ruling.
    await seed({
      minor: true,
      flags: { minor: { ...verdict, appealUpheld: { at: 'x', by: 1, textHash: SCANNED } } },
    });

    expect(
      await stampModelTextScanAppeal({
        modelId: MODEL,
        userId: MOD,
        decision: 'appealUpheld',
        labels: ['minor'],
        via: 'moderator',
        expectTextHash: 'another-hash',
      })
    ).toBe(0);

    expect(await labels()).toEqual([]);
  });

  it('records a retried ruling once', async () => {
    await seed({ minor: true, flags: { minor: verdict } });
    const keep = () =>
      stampModelTextScanAppeal({
        modelId: MODEL,
        userId: MOD,
        decision: 'appealUpheld',
        labels: ['minor'],
        via: 'moderator',
      });

    await keep();
    await keep();

    expect(await labels()).toHaveLength(1);
  });

  it('leaves the ruling standing when the store refuses the label', async () => {
    await seed({ poi: true, flags: { poi: { ...verdict, prev: { nsfw: false } } } });
    await holder.db.query(`SELECT label_store.erase_owner($1)`, [OWNER]);

    expect(
      await grantModelTextScanPoi({
        modelId: MODEL,
        userId: MOD,
        grantHash: SCANNED,
        via: 'moderator',
      })
    ).toBe(true);

    const after = await model();
    expect(after.poi).toBe(false);
    expect(after.meta.textScanFlags.poi?.appealGranted).toMatchObject({ by: MOD });
    expect(await labels()).toEqual([]);
  });

  it('leaves the ruling standing when the store is missing', async () => {
    await seed({ minor: true, flags: { minor: verdict } });
    await holder.db.exec(`ALTER SCHEMA label_store RENAME TO label_store_absent`);
    try {
      expect(
        await stampModelTextScanAppeal({
          modelId: MODEL,
          userId: MOD,
          decision: 'appealUpheld',
          labels: ['minor'],
          via: 'moderator',
        })
      ).toBe(1);
      expect((await model()).meta.textScanFlags.minor?.appealUpheld).toMatchObject({ by: MOD });
    } finally {
      await holder.db.exec(`ALTER SCHEMA label_store_absent RENAME TO label_store`);
    }
  });
});
