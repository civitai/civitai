import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type { TextScanOutcome } from '~/server/services/text-scan/types';

// The grant writer and the re-flag guard are hand-written SQL that have to agree on the key path and
// the hash. A mocked statement cannot show that, so this runs both against real Postgres.

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
// A real transaction: the flag writers record their label under a savepoint, which needs one.
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
db.appeal.findFirst.mockImplementation(
  (async ({
    where,
  }: {
    where: { entityType: string; entityId: number; status: string; category?: null };
  }) =>
    (
      await holder.db.query(
        // Filters on category only when the caller asks for it, so a dropped filter shows.
        `SELECT id FROM "Appeal" WHERE "entityType" = $1 AND "entityId" = $2 AND status = $3${
          'category' in where ? ' AND category IS NULL' : ''
        }`,
        [where.entityType, where.entityId, where.status]
      )
    ).rows[0] ?? null) as never
);
db.entityModeration.findUnique.mockImplementation(
  (async ({
    where,
  }: {
    where: { entityType_entityId: { entityType: string; entityId: number } };
  }) =>
    (
      await holder.db.query(
        `SELECT result FROM "EntityModeration" WHERE "entityType" = $1 AND "entityId" = $2`,
        [where.entityType_entityId.entityType, where.entityType_entityId.entityId]
      )
    ).rows[0] ?? null) as never
);

const { mockSetModelMinor, mockSideEffects, mockCreateNotification, searchMode, labelMode } =
  vi.hoisted(() => ({
    mockSetModelMinor: vi.fn(),
    mockSideEffects: vi.fn(),
    mockCreateNotification: vi.fn(),
    searchMode: { value: 'off' as 'off' | 'shadow' | 'active' },
    labelMode: {
      value: 'auto' as 'auto' | 'review',
      beforeRead: undefined as undefined | (() => Promise<void>),
    },
  }));
// The rollout lives in redis; the helper that maps a mode to its row stays real.
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanWebSearchMode: async () => searchMode.value,
  getTextScanLabelMode: async () => {
    await labelMode.beforeRead?.();
    return labelMode.value;
  },
}));
vi.mock('~/server/services/model.service', () => ({
  setModelMinor: mockSetModelMinor,
  applyModelFlagSideEffects: mockSideEffects,
  clearPoiHashMeta: vi.fn(),
  restoreOwnerFlagOverride: vi.fn(),
}));
vi.mock('~/server/services/model-version.service', () => ({
  bustPublicModelResponseCache: vi.fn(),
}));
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateModelNsfwLevels: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/clickhouse/tracker', () => ({
  Tracker: class {
    entityChanges = vi.fn().mockResolvedValue(undefined);
  },
}));
const MODEL_ID = 7;
const CURRENT = { fields: [{ heading: 'Name', text: 'edited after the scan' }], declared: {} };
vi.mock('~/server/services/text-scan/profiles', () => ({
  getTextScanProfile: () => ({
    load: async (ids: number[]) => new Map(ids.map((id) => [id, CURRENT])),
  }),
}));
vi.mock('~/server/services/text-scan/profiles/index', () => ({}));

const { applyModelPoiMinor, grantModelTextScanPoi, stampModelTextScanAppeal } = await import(
  '~/server/services/text-scan/actions/model-poi-minor'
);
const { resolveTextScanRedetection } = await import(
  '~/server/services/text-scan/actions/redetection'
);
const { loadGrantTextHash, stampModeratorTextScanRuling } = await import(
  '~/server/services/text-scan/actions/appeal-text-hash'
);
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');

const FLAGGED = 'hash-flagged';
const SCANNED = 'hash-scanned';
const NEWER = 'hash-newer';

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, name text, description text, "userId" int, status text,
      minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
      nsfw boolean NOT NULL DEFAULT false, "sfwOnly" boolean NOT NULL DEFAULT false,
      "gallerySettings" jsonb, "lockedProperties" text[] NOT NULL DEFAULT '{}', meta jsonb
    );
    CREATE TABLE "Appeal" (
      id serial PRIMARY KEY, "entityType" text, "entityId" int, status text, category text
    );
    CREATE TABLE "EntityModeration" (
      "entityType" text, "entityId" int, "workflowId" text, result jsonb,
      PRIMARY KEY ("entityType", "entityId")
    );
  `);
});

const flagEntry = { at: 'x', workflowId: 'wf-old', reason: 'r', textHash: FLAGGED };

async function seed({
  minor = false,
  poi = false,
  scanHash,
  searchHash,
}: {
  minor?: boolean;
  poi?: boolean;
  scanHash?: string;
  searchHash?: string;
}) {
  await holder.db.exec(
    `DELETE FROM "Model"; DELETE FROM "EntityModeration"; DELETE FROM "Appeal";`
  );
  await holder.db.query(
    `INSERT INTO "Model" (id, name, "userId", status, minor, poi, nsfw, "sfwOnly", "lockedProperties", meta)
     VALUES ($1, 'm', 42, 'Published', $2, $3, false, false, $4, $5)`,
    [
      MODEL_ID,
      minor,
      poi,
      poi ? ['poi'] : [],
      JSON.stringify({
        textScanFlags: { minor: flagEntry, poi: { ...flagEntry, prev: { nsfw: false } } },
      }),
    ]
  );
  if (scanHash)
    await holder.db.query(`INSERT INTO "EntityModeration" VALUES ('Model', $1, 'wf-old', $2)`, [
      MODEL_ID,
      JSON.stringify({ version: 1, textHash: scanHash, promptIds: { p: 1 }, model: 'scan-model' }),
    ]);
  if (searchHash)
    await holder.db.query(
      `INSERT INTO "EntityModeration" VALUES ('Model:search', $1, 'wf-s', $2)`,
      [MODEL_ID, JSON.stringify({ version: 1, textHash: searchHash })]
    );
}
type StoredModel = {
  poi: boolean;
  minor: boolean;
  meta: {
    textScanFlags: Record<
      string,
      {
        textHash: string;
        appealGranted: { textHash: string; via: string; by: number };
        appealUpheld?: { by: number; via: string };
        redetected?: {
          kind?: 'first' | 'redetected';
          textHash: string;
          workflowId: string;
          reason: string;
          at: string;
          promptIds: unknown;
          model: unknown;
        };
        rulings?: { decision: string; textHash: string; via: string; reason?: string }[];
      }
    >;
  };
};
const stored = async () =>
  (await holder.db.query<StoredModel>(`SELECT * FROM "Model" WHERE id = $1`, [MODEL_ID])).rows[0];

const verdict = (label: 'minor' | 'poi'): TextScanOutcome => ({
  triggeredLabels: [],
  nsfwLevel: null,
  [label]: { detected: true, declared: false, newlyDetected: true, reason: 'r', names: [] },
});
const apply = (label: 'minor' | 'poi', textHash: string) =>
  applyModelPoiMinor({
    entityId: MODEL_ID,
    workflowId: 'wf-new',
    outcome: verdict(label),
    subject: CURRENT,
    textHash,
  } as never);

const clean = (label: 'minor' | 'poi', textHash: string) =>
  applyModelPoiMinor({
    entityId: MODEL_ID,
    workflowId: 'wf-clean',
    outcome: {
      triggeredLabels: [],
      nsfwLevel: null,
      [label]: { detected: false, declared: false, newlyDetected: false, reason: 'ok', names: [] },
    },
    subject: CURRENT,
    textHash,
  } as never);
const resolve = (label: 'minor' | 'poi', keep: boolean, textHash = NEWER) =>
  resolveTextScanRedetection({ modelId: MODEL_ID, label, keep, textHash, userId: 9 });

beforeEach(() => {
  vi.clearAllMocks();
  mockSetModelMinor.mockReset();
  mockSideEffects.mockReset();
  redisMock.sysRedis.eval.mockResolvedValue(1 as never);
  searchMode.value = 'off';
  labelMode.value = 'auto';
  labelMode.beforeRead = undefined;
});

describe('overturn grant reads the latest scan', () => {
  it('takes the hash of the latest completed scan, not the flagged or the live text', async () => {
    await seed({ scanHash: SCANNED });
    expect(await loadGrantTextHash('Model', MODEL_ID, 'minor')).toBe(SCANNED);
  });

  it('falls back to the composed current text when no scan completed', async () => {
    await seed({});
    expect(await loadGrantTextHash('Model', MODEL_ID, 'minor')).toBe(textScanTextHash(CURRENT));
  });
});

describe('minor', () => {
  const overturn = async () => {
    await stampModelTextScanAppeal({
      modelId: MODEL_ID,
      userId: 3,
      decision: 'appealGranted',
      labels: ['minor'],
      grantHashes: { minor: (await loadGrantTextHash('Model', MODEL_ID, 'minor'))! },
    });
  };

  it('stays unflagged when a verdict arrives for the scanned text', async () => {
    await seed({ scanHash: SCANNED });
    await overturn();
    expect((await stored()).meta.textScanFlags.minor.appealGranted).toMatchObject({
      textHash: SCANNED,
      via: 'appeal',
    });

    await apply('minor', SCANNED);

    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect((await stored()).meta.textScanFlags.minor.appealGranted.textHash).toBe(SCANNED);
  });

  it('records a re-detection, not a flag, when the verdict is for text edited after the scan', async () => {
    await seed({ scanHash: SCANNED });
    await overturn();

    await apply('minor', NEWER);

    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    const entry = (await stored()).meta.textScanFlags.minor;
    expect(entry.appealGranted.textHash).toBe(SCANNED);
    expect(entry.redetected).toMatchObject({
      kind: 'redetected',
      textHash: NEWER,
      workflowId: 'wf-new',
      reason: 'r',
      promptIds: { p: 1 },
      model: 'scan-model',
    });
    expect(Date.parse(entry.redetected!.at)).not.toBeNaN();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'minor re-detected after a human clear, awaiting moderator',
        entityId: MODEL_ID,
      })
    );
  });

  it('keeps the newest detection when the edited text is scanned again', async () => {
    await seed({ scanHash: SCANNED });
    await overturn();
    await apply('minor', NEWER);

    await apply('minor', 'hash-newest');

    expect((await stored()).meta.textScanFlags.minor.redetected?.textHash).toBe('hash-newest');
  });

  it('still flags a label no human ever cleared', async () => {
    await seed({});
    await apply('minor', NEWER);

    expect(mockSetModelMinor).toHaveBeenCalledWith(expect.objectContaining({ minor: true }));
    expect((await stored()).meta.textScanFlags.minor.textHash).toBe(NEWER);
  });

  describe('a moderator rules on the re-detection', () => {
    const redetect = async () => {
      await seed({ scanHash: SCANNED });
      await overturn();
      await apply('minor', NEWER);
      vi.clearAllMocks();
    };

    it('keep applies the flag as the scan would have, upholds, and keeps the grant in the history', async () => {
      await redetect();

      expect(await resolve('minor', true)).toBe('kept');

      expect(mockSetModelMinor).toHaveBeenCalledWith(
        expect.objectContaining({ minor: true, userId: 9, activity: 'setMinorTextScan' })
      );
      expect(mockCreateNotification).toHaveBeenCalledTimes(1);
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({ key: `model-text-scan-flagged:${MODEL_ID}:minor:wf-new` })
      );
      const entry = (await stored()).meta.textScanFlags.minor;
      expect(entry).toMatchObject({ workflowId: 'wf-new', textHash: NEWER });
      expect(entry.appealGranted).toBeUndefined();
      expect(entry.redetected).toBeUndefined();
      expect(entry.appealUpheld).toMatchObject({ by: 9, via: 'moderator' });
      expect(entry.rulings).toEqual([
        expect.objectContaining({ decision: 'appealGranted', textHash: SCANNED, via: 'appeal' }),
      ]);
    });

    it('dismiss clears the re-detected text, notifies nobody, and keeps the earlier grant', async () => {
      await redetect();

      expect(await resolve('minor', false)).toBe('dismissed');

      expect(mockSetModelMinor).not.toHaveBeenCalled();
      expect(mockCreateNotification).not.toHaveBeenCalled();
      const entry = (await stored()).meta.textScanFlags.minor;
      expect(entry.redetected).toBeUndefined();
      expect(entry.appealGranted).toMatchObject({ textHash: NEWER, via: 'moderator', by: 9 });
      expect(entry.rulings).toEqual([
        expect.objectContaining({ decision: 'appealGranted', textHash: SCANNED }),
      ]);

      // The re-detected text is now covered, so the same text scanned again stays quiet.
      await apply('minor', NEWER);
      expect(mockSetModelMinor).not.toHaveBeenCalled();
      expect((await stored()).meta.textScanFlags.minor.redetected).toBeUndefined();
    });

    it("stamps the moderator's reason and note on the ruling and the log line", async () => {
      await redetect();
      const ruling = { modelId: MODEL_ID, label: 'minor' as const, textHash: NEWER, userId: 9 };

      await resolveTextScanRedetection({ ...ruling, keep: true, reason: 'other', note: 'a 30yo' });

      expect((await stored()).meta.textScanFlags.minor.appealUpheld).toMatchObject({
        via: 'moderator',
        reason: 'other',
        note: 'a 30yo',
      });
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'kept', reason: 'other', note: 'a 30yo' })
      );
    });

    it('stamps the reason on a dismissal and leaves both keys off when none is given', async () => {
      await redetect();
      await resolveTextScanRedetection({
        modelId: MODEL_ID,
        label: 'minor',
        textHash: NEWER,
        userId: 9,
        keep: false,
        reason: 'not-a-minor',
      });
      const granted = (await stored()).meta.textScanFlags.minor.appealGranted;
      expect(granted).toMatchObject({ reason: 'not-a-minor', via: 'moderator' });
      expect(granted).not.toHaveProperty('note');

      await redetect();
      await resolve('minor', false);
      const plain = (await stored()).meta.textScanFlags.minor.appealGranted;
      expect(plain).not.toHaveProperty('reason');
      expect(plain).not.toHaveProperty('note');
    });

    it('refuses a label with nothing pending', async () => {
      await seed({ scanHash: SCANNED });
      await overturn();
      await expect(resolve('minor', true)).rejects.toThrow();
    });

    describe.each([
      ['keep', true],
      ['dismiss', false],
    ])('%s on a detection that moved since the moderator loaded the queue', (_name, keep) => {
      it('refuses the old hash and changes nothing', async () => {
        await redetect();
        await apply('minor', 'hash-moved');
        vi.clearAllMocks();
        const before = await stored();

        await expect(resolve('minor', keep, NEWER)).rejects.toThrow(/changed or was already/);

        expect(mockSetModelMinor).not.toHaveBeenCalled();
        expect(mockCreateNotification).not.toHaveBeenCalled();
        expect(await stored()).toEqual(before);
        expect((await stored()).meta.textScanFlags.minor.redetected?.textHash).toBe('hash-moved');
      });

      it('rules once: the second attempt is refused', async () => {
        await redetect();
        await resolve('minor', keep);

        await expect(resolve('minor', keep)).rejects.toThrow(/changed or was already/);

        expect(mockCreateNotification).toHaveBeenCalledTimes(keep ? 1 : 0);
        expect((await stored()).meta.textScanFlags.minor.rulings).toHaveLength(1);
      });
    });

    it('keep on a model flagged by another route closes the marker without a notice or ruling', async () => {
      await redetect();
      await holder.db.query(`UPDATE "Model" SET minor = true WHERE id = $1`, [MODEL_ID]);

      expect(await resolve('minor', true)).toBe('closed');

      expect(mockSetModelMinor).not.toHaveBeenCalled();
      expect(mockCreateNotification).not.toHaveBeenCalled();
      const entry = (await stored()).meta.textScanFlags.minor;
      expect(entry.redetected).toBeUndefined();
      expect(entry.appealUpheld).toBeUndefined();
      expect(entry.appealGranted.textHash).toBe(SCANNED);
    });

    it('keep refuses and keeps the marker when the flag write lands on nothing', async () => {
      await redetect();
      // The grant now covers the pending text, so the guarded write has nothing to flag over.
      await holder.db.query(
        `UPDATE "Model" SET meta = jsonb_set(meta, '{textScanFlags,minor,appealGranted,textHash}', to_jsonb($1::text)) WHERE id = $2`,
        [NEWER, MODEL_ID]
      );

      await expect(resolve('minor', true)).rejects.toThrow(/changed or was already/);

      expect(mockSetModelMinor).not.toHaveBeenCalled();
      expect(mockCreateNotification).not.toHaveBeenCalled();
      expect((await stored()).meta.textScanFlags.minor.redetected?.textHash).toBe(NEWER);
    });

    it('keep stays in the queue when setModelMinor fails, and a retry completes it', async () => {
      await redetect();
      mockSetModelMinor.mockRejectedValueOnce(new Error('search index down'));

      await expect(resolve('minor', true)).rejects.toThrow('search index down');
      expect((await stored()).meta.textScanFlags.minor.redetected?.textHash).toBe(NEWER);
      expect(mockCreateNotification).not.toHaveBeenCalled();

      expect(await resolve('minor', true)).toBe('kept');
      const entry = (await stored()).meta.textScanFlags.minor;
      expect(entry.redetected).toBeUndefined();
      expect(entry.rulings).toHaveLength(1);
      expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['keep', true],
      ['dismiss', false],
    ])('%s is refused while the owner has an open appeal', async (_name, keep) => {
      await redetect();
      await holder.db.query(
        `INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES ('Model', $1, 'Pending')`,
        [MODEL_ID]
      );

      await expect(resolve('minor', keep)).rejects.toThrow(/open appeal/);

      expect(mockCreateNotification).not.toHaveBeenCalled();
      expect((await stored()).meta.textScanFlags.minor.redetected?.textHash).toBe(NEWER);
    });

    it('carries a superseded ruling into the history with its reason but not its note', async () => {
      await redetect();
      await resolveTextScanRedetection({
        modelId: MODEL_ID,
        label: 'minor',
        textHash: NEWER,
        userId: 9,
        keep: true,
        reason: 'other',
        note: 'a 30yo',
      });
      await stampModelTextScanAppeal({
        modelId: MODEL_ID,
        userId: 3,
        decision: 'appealUpheld',
        labels: ['minor'],
      });

      const carried = (await stored()).meta.textScanFlags.minor.rulings!.find(
        (r) => r.decision === 'appealUpheld'
      );
      expect(carried).toMatchObject({ reason: 'other', via: 'moderator' });
      expect(carried).not.toHaveProperty('note');
    });

    // A site-form appeal on the model is about its unpublish, not the flag, so it holds nothing.
    it('is not held by a site-form appeal on the model', async () => {
      await redetect();
      await holder.db.query(
        `INSERT INTO "Appeal" ("entityType", "entityId", status, category) VALUES ('Model', $1, 'Pending', 'Model')`,
        [MODEL_ID]
      );

      expect(await resolve('minor', true)).toBe('kept');
    });

    it('caps the history at the newest rulings, grants and upholds alike', async () => {
      await redetect();
      for (let i = 0; i < 5; i++) {
        await holder.db.query(
          `UPDATE "Model" SET meta = jsonb_set(meta, '{textScanFlags,minor,redetected}', $1::jsonb) WHERE id = $2`,
          [JSON.stringify({ workflowId: `wf-${i}`, reason: 'r', textHash: `h-${i}` }), MODEL_ID]
        );
        // Each keep carries the grant and the upheld ruling it replaces; the moderator then lifts it
        // again with a fresh grant.
        await resolve('minor', true, `h-${i}`);
        await holder.db.query(`UPDATE "Model" SET minor = false WHERE id = $1`, [MODEL_ID]);
        await stampModelTextScanAppeal({
          modelId: MODEL_ID,
          userId: 3,
          decision: 'appealGranted',
          labels: ['minor'],
          grantHashes: { minor: `g-${i}` },
        });
      }
      // Carried so far, oldest first: scanned, h-0, g-0, h-1, g-1, h-2, g-2, h-3, g-3.
      const { rulings } = (await stored()).meta.textScanFlags.minor;
      expect(rulings!.map((r) => [r.decision, r.textHash])).toEqual([
        ['appealGranted', 'g-1'],
        ['appealUpheld', 'h-2'],
        ['appealGranted', 'g-2'],
        ['appealUpheld', 'h-3'],
        ['appealGranted', 'g-3'],
      ]);
    });
  });

  describe('a superseded re-detection', () => {
    const redetect = async () => {
      await seed({ scanHash: SCANNED });
      await overturn();
      await apply('minor', NEWER);
    };
    const pending = async () => (await stored()).meta.textScanFlags.minor.redetected;

    it('is cleared by a clean scan of different text', async () => {
      await redetect();
      await clean('minor', 'hash-clean');
      expect(await pending()).toBeUndefined();
      expect((await stored()).meta.textScanFlags.minor.appealGranted.textHash).toBe(SCANNED);
    });

    it('survives a clean scan of the very text that was re-detected', async () => {
      await redetect();
      await clean('minor', NEWER);
      expect((await pending())?.textHash).toBe(NEWER);
    });

    it('is cleared when the owner reverts to the text the grant covers', async () => {
      await redetect();
      await apply('minor', SCANNED);
      expect(await pending()).toBeUndefined();
      expect(mockSetModelMinor).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a moderator ruling',
        () => stampModeratorTextScanRuling({ modelId: MODEL_ID, userId: 9, label: 'minor' }),
      ],
      [
        'an appeal overturn',
        () =>
          stampModelTextScanAppeal({
            modelId: MODEL_ID,
            userId: 9,
            decision: 'appealGranted',
            labels: ['minor'],
            grantHashes: { minor: 'g-new' },
          }),
      ],
      [
        'an upheld appeal',
        () =>
          stampModelTextScanAppeal({
            modelId: MODEL_ID,
            userId: 9,
            decision: 'appealUpheld',
            labels: ['minor'],
          }),
      ],
    ])('is cleared by %s on the label', async (_name, rule) => {
      await redetect();
      await rule();
      expect(await pending()).toBeUndefined();
    });

    it('a moderator ruling moves the grant it supersedes into the history', async () => {
      await redetect();
      await stampModeratorTextScanRuling({ modelId: MODEL_ID, userId: 9, label: 'minor' });
      const entry = (await stored()).meta.textScanFlags.minor;
      expect(entry.appealGranted).toMatchObject({ by: 9, via: 'moderator' });
      expect(entry.rulings).toEqual([
        expect.objectContaining({ decision: 'appealGranted', textHash: SCANNED }),
      ]);
    });
  });
});

describe('poi', () => {
  const overturn = async () =>
    grantModelTextScanPoi({
      modelId: MODEL_ID,
      userId: 3,
      grantHash: (await loadGrantTextHash('Model', MODEL_ID, 'poi'))!,
    });

  it('stays unflagged when a verdict arrives for the scanned text', async () => {
    await seed({ poi: true, scanHash: SCANNED });
    expect(await overturn()).toBe(true);
    expect((await stored()).poi).toBe(false);

    await apply('poi', SCANNED);

    const row = await stored();
    expect(row.poi).toBe(false);
    expect(row.meta.textScanFlags.poi.appealGranted.textHash).toBe(SCANNED);
  });

  it('records a re-detection, not a flag, when the verdict is for text edited after the scan', async () => {
    await seed({ poi: true, scanHash: SCANNED });
    await overturn();

    await apply('poi', NEWER);

    const row = await stored();
    expect(row.poi).toBe(false);
    expect(row.meta.textScanFlags.poi.appealGranted.textHash).toBe(SCANNED);
    expect(row.meta.textScanFlags.poi.redetected?.textHash).toBe(NEWER);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('keep flags and restricts the model; the earlier grant moves into the history', async () => {
    await seed({ poi: true, scanHash: SCANNED });
    await overturn();
    await apply('poi', NEWER);

    expect(await resolve('poi', true)).toBe('kept');

    const row = await stored();
    expect(row.poi).toBe(true);
    const entry = row.meta.textScanFlags.poi;
    expect(entry.redetected).toBeUndefined();
    expect(entry.appealGranted).toBeUndefined();
    expect(entry.appealUpheld).toMatchObject({ via: 'moderator' });
    expect(entry.rulings).toEqual([
      expect.objectContaining({ decision: 'appealGranted', textHash: SCANNED }),
    ]);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });
});

describe('poi re-detections', () => {
  const grantPoi = async () =>
    grantModelTextScanPoi({
      modelId: MODEL_ID,
      userId: 3,
      grantHash: (await loadGrantTextHash('Model', MODEL_ID, 'poi'))!,
    });
  const redetectPoi = async () => {
    await seed({ poi: true, scanHash: SCANNED });
    await grantPoi();
    await apply('poi', NEWER);
    vi.clearAllMocks();
  };
  const pendingPoi = async () => (await stored()).meta.textScanFlags.poi.redetected;

  it('a clean scan of different text clears the marker', async () => {
    await redetectPoi();
    await clean('poi', 'hash-clean');
    expect(await pendingPoi()).toBeUndefined();
  });

  it('the owner reverting to the cleared text clears the marker', async () => {
    await redetectPoi();
    await apply('poi', SCANNED);
    expect(await pendingPoi()).toBeUndefined();
  });

  it('a second overturn strips the marker and moves the grant it replaces into the history', async () => {
    await redetectPoi();
    await holder.db.query(`UPDATE "Model" SET poi = true WHERE id = $1`, [MODEL_ID]);
    await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 4, grantHash: 'g-second' });
    const entry = (await stored()).meta.textScanFlags.poi;
    expect(entry.redetected).toBeUndefined();
    expect(entry.appealGranted).toMatchObject({ textHash: 'g-second', by: 4 });
    expect(entry.rulings).toEqual([
      expect.objectContaining({ decision: 'appealGranted', textHash: SCANNED }),
    ]);
  });

  it('dismiss clears the new text and tells nobody', async () => {
    await redetectPoi();
    expect(await resolve('poi', false)).toBe('dismissed');
    const entry = (await stored()).meta.textScanFlags.poi;
    expect(entry.appealGranted).toMatchObject({ textHash: NEWER, via: 'moderator', by: 9 });
    expect(entry.redetected).toBeUndefined();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('refuses a ruling on a hash that moved since the queue loaded', async () => {
    await redetectPoi();
    await apply('poi', 'hash-moved');
    await expect(resolve('poi', true, NEWER)).rejects.toThrow(/changed or was already/);
    await expect(resolve('poi', false, NEWER)).rejects.toThrow(/changed or was already/);
    expect((await stored()).poi).toBe(false);
  });

  it('keep and dismiss on a model flagged by another route only close the marker', async () => {
    for (const keep of [true, false]) {
      await redetectPoi();
      await holder.db.query(`UPDATE "Model" SET poi = true WHERE id = $1`, [MODEL_ID]);
      expect(await resolve('poi', keep)).toBe('closed');
      const entry = (await stored()).meta.textScanFlags.poi;
      expect(entry.redetected).toBeUndefined();
      expect(entry.appealGranted.textHash).toBe(SCANNED);
      expect(entry.appealUpheld).toBeUndefined();
      expect(mockCreateNotification).not.toHaveBeenCalled();
      expect(mockSideEffects).not.toHaveBeenCalled();
    }
  });
});

describe('a keep that fails part-way', () => {
  it('poi: a retry runs the side effects, notice and ruling that were missed', async () => {
    await seed({ poi: true, scanHash: SCANNED });
    await grantModelTextScanPoi({
      modelId: MODEL_ID,
      userId: 3,
      grantHash: (await loadGrantTextHash('Model', MODEL_ID, 'poi'))!,
    });
    await apply('poi', NEWER);
    vi.clearAllMocks();
    mockSideEffects.mockReset();
    mockSideEffects.mockRejectedValueOnce(new Error('search index down'));

    await expect(resolve('poi', true)).rejects.toThrow('search index down');
    // The column is set but nothing propagated, and the item is still in the queue.
    expect((await stored()).poi).toBe(true);
    expect((await stored()).meta.textScanFlags.poi.redetected?.textHash).toBe(NEWER);
    expect(mockCreateNotification).not.toHaveBeenCalled();

    // Neither a dismissal nor a second moderator may treat it as flagged by someone else.
    await expect(resolve('poi', false)).rejects.toThrow(/unfinished/);

    expect(await resolve('poi', true)).toBe('kept');

    expect(mockSideEffects).toHaveBeenCalledTimes(2);
    expect(mockSideEffects.mock.calls[1][0]).toMatchObject({
      before: { poi: false },
      after: { poi: true },
    });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    const entry = (await stored()).meta.textScanFlags.poi;
    expect(entry.appealUpheld).toMatchObject({ by: 9, via: 'moderator' });
    expect(entry.redetected).toBeUndefined();
    expect(entry.rulings).toHaveLength(1);
  });

  it('minor: a retry finishes after setModelMinor set the column and then failed', async () => {
    await seed({ scanHash: SCANNED });
    await holder.db.query(
      `UPDATE "Model" SET meta = jsonb_set(meta, '{textScanFlags,minor,appealGranted}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify({ at: 'x', by: 3, textHash: SCANNED, via: 'appeal' }), MODEL_ID]
    );
    await apply('minor', NEWER);
    vi.clearAllMocks();
    mockSetModelMinor.mockReset();
    mockSetModelMinor.mockImplementationOnce(async () => {
      await holder.db.query(`UPDATE "Model" SET minor = true WHERE id = $1`, [MODEL_ID]);
      throw new Error('fan-out failed');
    });

    await expect(resolve('minor', true)).rejects.toThrow('fan-out failed');
    expect((await stored()).minor).toBe(true);
    expect((await stored()).meta.textScanFlags.minor.redetected?.textHash).toBe(NEWER);

    expect(await resolve('minor', true)).toBe('kept');

    expect(mockSetModelMinor).toHaveBeenCalledTimes(2);
    expect(mockSetModelMinor.mock.calls[1][0]).toMatchObject({
      minor: true,
      reapplySideEffects: true,
    });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    const entry = (await stored()).meta.textScanFlags.minor;
    expect(entry.appealUpheld).toMatchObject({ by: 9 });
    expect(entry.redetected).toBeUndefined();
    expect(entry.rulings).toHaveLength(1);
  });
});

describe('resolution safety', () => {
  const setup = async () => {
    await seed({ scanHash: SCANNED });
    await stampModelTextScanAppeal({
      modelId: MODEL_ID,
      userId: 3,
      decision: 'appealGranted',
      labels: ['minor'],
      grantHashes: { minor: SCANNED },
    });
    await apply('minor', NEWER);
    vi.clearAllMocks();
    mockSetModelMinor.mockReset();
  };

  it('refuses a request while another resolution of the same label runs', async () => {
    await setup();
    redisMock.sysRedis.set.mockResolvedValueOnce(null as never);

    await expect(resolve('minor', true)).rejects.toThrow(/being resolved/);

    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.del).not.toHaveBeenCalled();
    expect((await stored()).meta.textScanFlags.minor.redetected?.textHash).toBe(NEWER);
  });

  it('takes a per-request token lock per model and label and releases only its own token', async () => {
    await setup();
    await resolve('minor', false);

    const key = `system:text-scan:redetection-lock:${MODEL_ID}:minor`;
    const [setKey, token, options] = redisMock.sysRedis.set.mock.calls[0] as unknown as [
      string,
      string,
      unknown
    ];
    expect(setKey).toBe(key);
    expect(options).toEqual({ NX: true, EX: 120 });
    expect(token).not.toBe('1');
    // Compare-and-delete: the script frees the key only while it still holds this request's token.
    const [script, args] = redisMock.sysRedis.eval.mock.calls[0] as unknown as [
      string,
      { keys: string[]; arguments: string[] }
    ];
    expect(script).toContain("GET', KEYS[1]) == ARGV[1]");
    expect(args).toEqual({ keys: [key], arguments: [token] });
    expect(redisMock.sysRedis.del).not.toHaveBeenCalled();

    // A second request holds a different token, so it never releases the first's.
    redisMock.sysRedis.set.mockClear();
    redisMock.sysRedis.eval.mockClear();
    await expect(resolve('minor', false)).rejects.toThrow();
    const secondToken = (redisMock.sysRedis.set.mock.calls[0] as unknown as string[])[1];
    expect(secondToken).not.toBe(token);
    expect(redisMock.sysRedis.eval).toHaveBeenCalledTimes(1);
  });

  it('removes an emptied label entry and the flags object when dismissing on a flagged model', async () => {
    await seed({ minor: true });
    const marker = { workflowId: 'w', reason: 'r', textHash: NEWER };
    const setMeta = (meta: unknown) =>
      holder.db.query(`UPDATE "Model" SET meta = $1::jsonb WHERE id = $2`, [
        JSON.stringify(meta),
        MODEL_ID,
      ]);

    await setMeta({ textScanFlags: { minor: { redetected: marker } } });
    expect(await resolve('minor', false)).toBe('closed');
    expect(
      (await holder.db.query(`SELECT meta FROM "Model" WHERE id = $1`, [MODEL_ID])).rows[0]
    ).toEqual({
      meta: {},
    });

    await setMeta({
      textScanFlags: {
        minor: { redetected: marker },
        poi: { workflowId: 'p', textHash: 'x' },
      },
    });
    await resolve('minor', false);
    expect((await stored()).meta.textScanFlags).toEqual({
      poi: { workflowId: 'p', textHash: 'x' },
    });
  });

  it.each([
    [
      'another model',
      async () =>
        holder.db.query(
          `INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES ('Model', 999, 'Pending')`
        ),
    ],
    [
      'a decided appeal on this model',
      async () =>
        holder.db.query(
          `INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES ('Model', ${MODEL_ID}, 'Approved')`
        ),
    ],
    [
      'a pending appeal on another entity type',
      async () =>
        holder.db.query(
          `INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES ('Bounty', ${MODEL_ID}, 'Pending')`
        ),
    ],
  ])('does not block on %s', async (_name, insert) => {
    await setup();
    await insert();
    expect(await resolve('minor', false)).toBe('dismissed');
  });
});

// When the web-search pass is active it owns poi and minor, and finishes apart from the main pass,
// so the two rows can hold different hashes for a moment after an edit.
describe('web search active', () => {
  const MAIN = 'hash-main';
  const SEARCH = 'hash-search';
  beforeEach(() => {
    searchMode.value = 'active';
  });

  it('takes the hash from the search row for poi and minor', async () => {
    await seed({ scanHash: MAIN, searchHash: SEARCH });
    expect(await loadGrantTextHash('Model', MODEL_ID, 'minor')).toBe(SEARCH);
    expect(await loadGrantTextHash('Model', MODEL_ID, 'poi')).toBe(SEARCH);
  });

  it('falls back to the composed text when the search row has no completed scan', async () => {
    await seed({ scanHash: MAIN });
    expect(await loadGrantTextHash('Model', MODEL_ID, 'minor')).toBe(textScanTextHash(CURRENT));
  });

  it('minor: a verdict for the searched text stays unflagged, the main row text is re-detected', async () => {
    await seed({ scanHash: MAIN, searchHash: SEARCH });
    await stampModelTextScanAppeal({
      modelId: MODEL_ID,
      userId: 3,
      decision: 'appealGranted',
      labels: ['minor'],
      grantHashes: { minor: (await loadGrantTextHash('Model', MODEL_ID, 'minor'))! },
    });

    await apply('minor', SEARCH);
    expect(mockSetModelMinor).not.toHaveBeenCalled();

    await apply('minor', MAIN);
    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect((await stored()).meta.textScanFlags.minor.redetected?.textHash).toBe(MAIN);
  });

  it('poi: a verdict for the searched text stays unflagged, the main row text is re-detected', async () => {
    await seed({ poi: true, scanHash: MAIN, searchHash: SEARCH });
    await grantModelTextScanPoi({
      modelId: MODEL_ID,
      userId: 3,
      grantHash: (await loadGrantTextHash('Model', MODEL_ID, 'poi'))!,
    });

    await apply('poi', SEARCH);
    expect((await stored()).poi).toBe(false);

    await apply('poi', MAIN);
    const row = await stored();
    expect(row.poi).toBe(false);
    expect(row.meta.textScanFlags.poi.redetected?.textHash).toBe(MAIN);
  });
});

describe('review mode: a first detection waits for a moderator', () => {
  const entryOf = async (label: 'minor' | 'poi' = 'minor') =>
    (await stored()).meta.textScanFlags[label];
  const hold = async (label: 'minor' | 'poi' = 'minor') => {
    labelMode.value = 'review';
    await seed({ scanHash: SCANNED });
    await apply(label, NEWER);
    vi.clearAllMocks();
  };

  it('records a first marker and sets, locks and tells nothing', async () => {
    labelMode.value = 'review';
    await seed({ scanHash: SCANNED });

    await apply('minor', NEWER);

    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    const row = await stored();
    expect(row.minor).toBe(false);
    expect((await entryOf()).redetected).toMatchObject({
      kind: 'first',
      textHash: NEWER,
      workflowId: 'wf-new',
      reason: 'r',
      promptIds: { p: 1 },
      model: 'scan-model',
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'text-scan',
        message: 'minor first detection held, awaiting moderator',
        entityType: 'Model',
        entityId: MODEL_ID,
      })
    );
  });

  // A model published with an empty meta stores JSON `null` there, and `COALESCE(meta, '{}') || x`
  // turned it into `[null, x]`: on 2026-10-18 four held detections did this, and prepare-leaderboard's
  // jsonb_set then threw on them and built no board.
  it('writes an object, not an array, over a JSON-null meta', async () => {
    labelMode.value = 'review';
    await seed({ scanHash: SCANNED });
    await holder.db.query(`UPDATE "Model" SET meta = 'null'::jsonb WHERE id = $1`, [MODEL_ID]);

    await apply('minor', NEWER);

    const { meta } = await stored();
    expect(Array.isArray(meta)).toBe(false);
    expect(meta.textScanFlags.minor.redetected).toMatchObject({ kind: 'first', textHash: NEWER });
  });

  it.each(['minor', 'poi'] as const)(
    'writes an object over a JSON-null meta when %s is flagged straight away',
    async (label) => {
      await seed({ scanHash: SCANNED });
      await holder.db.query(`UPDATE "Model" SET meta = 'null'::jsonb WHERE id = $1`, [MODEL_ID]);

      await apply(label, NEWER);

      const { meta } = await stored();
      expect(Array.isArray(meta)).toBe(false);
      expect(meta.textScanFlags[label].textHash).toBe(NEWER);
    }
  );

  it('holds poi the same way, without restricting the model', async () => {
    await hold('poi');
    expect((await entryOf('poi')).redetected).toMatchObject({ kind: 'first', textHash: NEWER });
    expect((await stored()).poi).toBe(false);
    expect(mockSideEffects).not.toHaveBeenCalled();
  });

  it('flags straight away while the label is on auto', async () => {
    await seed({ scanHash: SCANNED });
    await apply('minor', NEWER);
    expect(mockSetModelMinor).toHaveBeenCalledWith(expect.objectContaining({ minor: true }));
    expect((await entryOf()).redetected).toBeUndefined();
  });

  it('does not hold a label that is already locked or flagged', async () => {
    labelMode.value = 'review';
    await seed({ scanHash: SCANNED });
    await holder.db.query(`UPDATE "Model" SET "lockedProperties" = '{minor}' WHERE id = $1`, [
      MODEL_ID,
    ]);
    await apply('minor', NEWER);
    expect((await entryOf()).redetected).toBeUndefined();

    await holder.db.query(
      `UPDATE "Model" SET "lockedProperties" = '{}', minor = true WHERE id = $1`,
      [MODEL_ID]
    );
    await apply('minor', 'hash-other');
    expect((await entryOf()).redetected).toBeUndefined();
  });

  it('marks a detection over an earlier human clear as a re-detection, whatever the mode', async () => {
    labelMode.value = 'review';
    await seed({ scanHash: SCANNED });
    await stampModelTextScanAppeal({
      modelId: MODEL_ID,
      userId: 3,
      decision: 'appealGranted',
      labels: ['minor'],
      grantHashes: { minor: SCANNED },
    });

    await apply('minor', NEWER);

    expect((await entryOf()).redetected?.kind).toBe('redetected');
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });

  it('keeps the original time when the same text is detected again', async () => {
    await hold();
    const { at } = (await entryOf()).redetected!;
    await apply('minor', NEWER);
    expect((await entryOf()).redetected!.at).toBe(at);
  });

  it('replaces the marker when the owner edits and the new text is detected', async () => {
    await hold();
    await apply('minor', 'hash-newest');
    expect((await entryOf()).redetected).toMatchObject({ kind: 'first', textHash: 'hash-newest' });
  });

  it('drops the marker when a later scan of different text comes back clean', async () => {
    await hold();
    await clean('minor', 'hash-clean');
    expect((await entryOf()).redetected).toBeUndefined();
  });

  it('keeps the marker when a clean verdict arrives for the very text that is held', async () => {
    await hold();
    await clean('minor', NEWER);
    expect((await entryOf()).redetected?.textHash).toBe(NEWER);
  });

  it('keep flags the model as the scan would have, notifies, and clears the marker', async () => {
    await hold();

    expect(await resolve('minor', true)).toBe('kept');

    expect(mockSetModelMinor).toHaveBeenCalledWith(
      expect.objectContaining({ minor: true, userId: 9, activity: 'setMinorTextScan' })
    );
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    const entry = await entryOf();
    expect(entry).toMatchObject({ workflowId: 'wf-new', textHash: NEWER });
    expect(entry.redetected).toBeUndefined();
    expect(entry.appealUpheld).toMatchObject({ by: 9, via: 'moderator' });
  });

  it('dismiss rules on that text: it is never held again, and nothing is flagged', async () => {
    await hold();

    expect(await resolve('minor', false)).toBe('dismissed');

    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    const entry = await entryOf();
    expect(entry.redetected).toBeUndefined();
    expect(entry.appealGranted).toMatchObject({ textHash: NEWER, via: 'moderator', by: 9 });

    await apply('minor', NEWER);
    expect((await entryOf()).redetected).toBeUndefined();
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });

  it('after a dismissal, a detection on different text is an ordinary re-detection', async () => {
    await hold();
    await resolve('minor', false);

    await apply('minor', 'hash-later');

    const marker = (await entryOf()).redetected!;
    expect(marker.textHash).toBe('hash-later');
    expect(marker.kind).toBe('redetected');
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });

  it.each([
    ['keep', true],
    ['dismiss', false],
  ])('%s of a held detection the text has moved past is refused', async (_name, keep) => {
    await hold();
    await apply('minor', 'hash-moved');
    vi.clearAllMocks();
    await expect(resolve('minor', keep, NEWER)).rejects.toThrow(/changed or was already/);
    expect((await entryOf()).redetected?.textHash).toBe('hash-moved');
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  describe('rolling the switch back to auto while a detection is held', () => {
    const rollBack = async () => {
      await hold();
      labelMode.value = 'auto';
      await apply('minor', NEWER);
    };

    it('flags on the next scan of the held text and leaves no marker for the queue', async () => {
      await rollBack();

      expect(mockSetModelMinor).toHaveBeenCalledWith(expect.objectContaining({ minor: true }));
      const entry = await entryOf();
      expect(entry).toMatchObject({ workflowId: 'wf-new', textHash: NEWER });
      expect(entry.redetected).toBeUndefined();
    });

    it.each([
      ['keep', true],
      ['dismiss', false],
    ])('%s on the stale queue row is refused: no second flag, no ruling', async (_name, keep) => {
      await rollBack();
      await holder.db.query(`UPDATE "Model" SET minor = true WHERE id = $1`, [MODEL_ID]);
      vi.clearAllMocks();
      const before = await stored();

      await expect(resolve('minor', keep)).rejects.toThrow(/changed or was already/);

      expect(mockSetModelMinor).not.toHaveBeenCalled();
      expect(mockCreateNotification).not.toHaveBeenCalled();
      expect(await stored()).toEqual(before);
      expect((await entryOf()).appealUpheld).toBeUndefined();
      expect((await entryOf()).appealGranted).toBeUndefined();
    });
  });

  it.each([
    ['keep', true, 'kept'],
    ['dismiss', false, 'dismissed'],
  ])('logs the %s decision with the prompts behind the verdict', async (_name, keep, decision) => {
    await hold();

    await resolve('minor', keep);

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'text-scan',
        message: 'held detection resolved',
        entityType: 'Model',
        entityId: MODEL_ID,
        label: 'minor',
        kind: 'first',
        decision,
        promptIds: { p: 1 },
        moderatorId: 9,
      })
    );
  });

  it('still holds the new text as a re-detection when a dismissal of the old text lands mid-scan', async () => {
    labelMode.value = 'review';
    await seed({ scanHash: SCANNED });
    // Between the scan's read of the model and the hold write, a moderator dismisses the old text.
    labelMode.beforeRead = async () => {
      labelMode.beforeRead = undefined;
      await holder.db.query(
        `UPDATE "Model" SET meta = jsonb_set(meta, '{textScanFlags,minor,appealGranted}', $1::jsonb) WHERE id = $2`,
        [JSON.stringify({ at: 'x', by: 9, textHash: 'hash-old', via: 'moderator' }), MODEL_ID]
      );
    };

    await apply('minor', NEWER);

    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect((await entryOf()).redetected).toMatchObject({ kind: 'redetected', textHash: NEWER });
  });

  it('logs the decision of a marker written before kinds existed as a re-detection', async () => {
    await hold();
    await holder.db.query(
      `UPDATE "Model" SET meta = meta #- '{textScanFlags,minor,redetected,kind}' WHERE id = $1`,
      [MODEL_ID]
    );

    await resolve('minor', false);

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'held detection resolved', kind: 'redetected' })
    );
  });

  it('records no reason or note when the resolution closes', async () => {
    await hold();
    await holder.db.query(`UPDATE "Model" SET minor = true WHERE id = $1`, [MODEL_ID]);

    expect(
      await resolveTextScanRedetection({
        modelId: MODEL_ID,
        label: 'minor',
        textHash: (await stored()).meta.textScanFlags.minor.redetected!.textHash,
        userId: 9,
        keep: true,
        reason: 'detection-correct',
        note: 'seen',
      })
    ).toBe('closed');

    expect(JSON.stringify((await stored()).meta)).not.toMatch(/detection-correct|"note"/);
    const logged = loggingMock.logToAxiom.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(logged).toMatchObject({ decision: 'closed' });
    expect(logged).not.toHaveProperty('reason');
    expect(logged).not.toHaveProperty('note');
  });

  it('logs a resolution that closed because the model was flagged another way', async () => {
    await hold();
    await holder.db.query(`UPDATE "Model" SET minor = true WHERE id = $1`, [MODEL_ID]);

    expect(await resolve('minor', true)).toBe('closed');

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'held detection resolved',
        decision: 'closed',
        kind: 'first',
        promptIds: { p: 1 },
        moderatorId: 9,
      })
    );
  });

  describe('a first write that matches nothing for a correct reason', () => {
    const holdLogs = () =>
      loggingMock.logToAxiom.mock.calls.filter(([entry]) =>
        /awaiting moderator/.test((entry as { message?: string }).message ?? '')
      );

    it('does not retry the same text as a re-detection or log a second hold', async () => {
      await hold();
      const before = await entryOf();

      await apply('minor', NEWER);

      expect((await entryOf()).redetected).toEqual(before.redetected);
      expect((await entryOf()).redetected?.kind).toBe('first');
      expect(holdLogs()).toHaveLength(0);
    });

    it('writes nothing for a locked label', async () => {
      labelMode.value = 'review';
      await seed({ scanHash: SCANNED });
      await holder.db.query(`UPDATE "Model" SET "lockedProperties" = '{minor}' WHERE id = $1`, [
        MODEL_ID,
      ]);
      const before = await stored();

      await apply('minor', NEWER);

      expect(await stored()).toEqual(before);
      expect(holdLogs()).toHaveLength(0);
    });

    it('writes nothing when the label is flagged between the read and the write', async () => {
      labelMode.value = 'review';
      await seed({ scanHash: SCANNED });
      labelMode.beforeRead = async () => {
        labelMode.beforeRead = undefined;
        await holder.db.query(`UPDATE "Model" SET minor = true WHERE id = $1`, [MODEL_ID]);
      };

      await apply('minor', NEWER);

      expect((await entryOf()).redetected).toBeUndefined();
      expect(holdLogs()).toHaveLength(0);
    });
  });

  it('holds poi as a re-detection when a dismissal lands mid-scan', async () => {
    labelMode.value = 'review';
    await seed({ scanHash: SCANNED });
    labelMode.beforeRead = async () => {
      labelMode.beforeRead = undefined;
      await holder.db.query(
        `UPDATE "Model" SET meta = jsonb_set(meta, '{textScanFlags,poi,appealGranted}', $1::jsonb) WHERE id = $2`,
        [JSON.stringify({ at: 'x', by: 9, textHash: 'hash-old', via: 'moderator' }), MODEL_ID]
      );
    };

    await apply('poi', NEWER);

    expect((await stored()).poi).toBe(false);
    expect((await entryOf('poi')).redetected).toMatchObject({
      kind: 'redetected',
      textHash: NEWER,
    });
  });
});
