import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
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

const { mockSetModelMinor } = vi.hoisted(() => ({ mockSetModelMinor: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  setModelMinor: mockSetModelMinor,
  applyModelFlagSideEffects: vi.fn(),
}));
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
const { loadGrantTextHash } = await import('~/server/services/text-scan/actions/appeal-text-hash');
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
}: {
  minor?: boolean;
  poi?: boolean;
  scanHash?: string;
}) {
  await holder.db.exec(`DELETE FROM "Model"; DELETE FROM "EntityModeration";`);
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
      JSON.stringify({ version: 1, textHash: scanHash }),
    ]);
}
type StoredModel = {
  poi: boolean;
  meta: {
    textScanFlags: Record<
      string,
      { textHash: string; appealGranted: { textHash: string; via: string } }
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

beforeEach(() => vi.clearAllMocks());

describe('overturn grant reads the latest scan', () => {
  it('takes the hash of the latest completed scan, not the flagged or the live text', async () => {
    await seed({ scanHash: SCANNED });
    expect(await loadGrantTextHash('Model', MODEL_ID)).toBe(SCANNED);
  });

  it('falls back to the composed current text when no scan completed', async () => {
    await seed({});
    expect(await loadGrantTextHash('Model', MODEL_ID)).toBe(textScanTextHash(CURRENT));
  });
});

describe('minor', () => {
  const overturn = async () => {
    await stampModelTextScanAppeal({
      modelId: MODEL_ID,
      userId: 3,
      decision: 'appealGranted',
      labels: ['minor'],
      grantHash: (await loadGrantTextHash('Model', MODEL_ID))!,
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

  it('re-flags when the verdict is for text edited after the scan', async () => {
    await seed({ scanHash: SCANNED });
    await overturn();

    await apply('minor', NEWER);

    expect(mockSetModelMinor).toHaveBeenCalledWith(expect.objectContaining({ minor: true }));
    expect((await stored()).meta.textScanFlags.minor.textHash).toBe(NEWER);
  });
});

describe('poi', () => {
  const overturn = async () =>
    grantModelTextScanPoi({
      modelId: MODEL_ID,
      userId: 3,
      grantHash: (await loadGrantTextHash('Model', MODEL_ID))!,
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

  it('re-flags when the verdict is for text edited after the scan', async () => {
    await seed({ poi: true, scanHash: SCANNED });
    await overturn();

    await apply('poi', NEWER);

    expect((await stored()).poi).toBe(true);
  });
});
