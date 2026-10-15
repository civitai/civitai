import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
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
db.model.findUnique.mockImplementation(
  (async ({ where }: { where: { id: number } }) =>
    (await holder.db.query(`SELECT * FROM "Model" WHERE id = $1`, [where.id])).rows[0] ??
    null) as never
);
db.appeal.findFirst.mockImplementation(
  (async ({ where }: { where: { entityType: string; entityId: number; status: string } }) =>
    (
      await holder.db.query(
        `SELECT id FROM "Appeal" WHERE "entityType" = $1 AND "entityId" = $2 AND status = $3`,
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

const { mockSetModelMinor, mockCreateNotification, searchMode } = vi.hoisted(() => ({
  mockSetModelMinor: vi.fn(),
  mockCreateNotification: vi.fn(),
  searchMode: { value: 'off' as 'off' | 'shadow' | 'active' },
}));
// The rollout lives in redis; the helper that maps a mode to its row stays real.
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanWebSearchMode: async () => searchMode.value,
}));
vi.mock('~/server/services/model.service', () => ({
  setModelMinor: mockSetModelMinor,
  applyModelFlagSideEffects: vi.fn(),
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
      id serial PRIMARY KEY, "entityType" text, "entityId" int, status text
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
          textHash: string;
          workflowId: string;
          reason: string;
          at: string;
          promptIds: unknown;
          model: unknown;
        };
        rulings?: { decision: string; textHash: string; via: string }[];
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
  searchMode.value = 'off';
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
      textHash: NEWER,
      workflowId: 'wf-new',
      reason: 'r',
      promptIds: { p: 1 },
      model: 'scan-model',
    });
    expect(Date.parse(entry.redetected!.at)).not.toBeNaN();
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
