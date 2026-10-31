import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as ModelService from '~/server/services/model.service';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

// What a minor hash rollback writes to the model row, against real Postgres.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const { mockSetModelMinor, mockRestoreOwnerFlagOverride, mockReassertPoi } = vi.hoisted(() => ({
  mockSetModelMinor: vi.fn(),
  mockRestoreOwnerFlagOverride: vi.fn(),
  mockReassertPoi: vi.fn(),
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  setModelMinor: mockSetModelMinor,
  restoreOwnerFlagOverride: mockRestoreOwnerFlagOverride,
}));
// A no-op, so a test sees the restore write alone, not the reassert that would repair it.
vi.mock('~/server/services/text-scan/actions/model-poi-minor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reassertModelPoiRestrictions: mockReassertPoi,
}));
vi.mock('~/server/services/creator-gallery-hidden-users.service', () => ({
  bustModelGallerySettings: vi.fn(),
  getCreatorGalleryHiddenUserIds: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({ queueImageSearchIndexUpdate: vi.fn() }));

// Inlined as literals: the statements bind JSON keys untyped (`meta ? $1`), which the real driver
// sends as text but PGlite refuses to infer.
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `ARRAY[${value.map(literal).join(', ')}]`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function run(strings: TemplateStringsArray, values: unknown[]) {
  const flat = Prisma.sql(strings, ...(values as never[]));
  const text = flat.text.replace(/\$(\d+)/g, (_, i: string) => literal(flat.values[Number(i) - 1]));
  return holder.db.query(text);
}

dbMock.dbWrite.$executeRaw.mockImplementation(
  (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await run(strings, values)).affectedRows ?? 0) as never
);
dbMock.dbRead.$queryRaw.mockImplementation(
  (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await run(strings, values)).rows) as never
);

const { rollbackMinorHashAutoFlags } = await import('~/server/services/minor-hash.service');

const MODEL_ID = 1;
const MATURE_LEVEL = 31;

type Seed = {
  poi?: boolean;
  availability?: string;
  snapshot: Record<string, unknown>;
  ownerFlagOverride?: Record<string, unknown>;
};

// A model as an auto flag leaves it: minor, SFW-only at the SFW level, with the minor locks.
async function seed({ poi = false, availability = 'Public', snapshot, ownerFlagOverride }: Seed) {
  await holder.db.query(
    `INSERT INTO "Model" (id, minor, nsfw, "sfwOnly", poi, availability, "gallerySettings",
       "lockedProperties", meta)
     VALUES ($1, true, false, true, $2, $3, $4::jsonb, '{minor,nsfw,sfwOnly}', $5::jsonb)`,
    [
      MODEL_ID,
      poi,
      availability,
      JSON.stringify({ level: sfwBrowsingLevelsFlag }),
      JSON.stringify({
        minorFlagSnapshot: { source: 'auto', at: '2020-01-01T00:00:00Z', ...snapshot },
        ...(ownerFlagOverride && { ownerFlagOverride }),
      }),
    ]
  );
}

const row = async () =>
  (
    await holder.db.query<Record<string, unknown>>(`SELECT * FROM "Model" WHERE id = $1`, [
      MODEL_ID,
    ])
  ).rows[0];

const rollback = () => rollbackMinorHashAutoFlags({ dryRun: false, limit: 10 });

// A mature, unlocked model before the flag.
const mature = {
  prevNsfw: true,
  prevSfwOnly: false,
  prevGalleryLevel: MATURE_LEVEL,
  prevLockedProperties: [],
};
// What an earlier minor flag leaves: SFW-only, not mature.
const sfwOnlyBefore = {
  prevNsfw: false,
  prevSfwOnly: true,
  prevGalleryLevel: sfwBrowsingLevelsFlag,
  prevLockedProperties: [],
};

beforeEach(async () => {
  vi.clearAllMocks();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
  mockReassertPoi.mockResolvedValue(false);
  mockRestoreOwnerFlagOverride.mockResolvedValue(undefined);
  // The unset a rollback asks for: minor and its locks go, the rating stays as the flag left it.
  mockSetModelMinor.mockImplementation(async ({ id }: { id: number }) => {
    await holder.db.query(
      `UPDATE "Model" SET minor = false,
         "lockedProperties" = array_remove(array_remove(array_remove("lockedProperties",
           'minor'), 'nsfw'), 'sfwOnly')
       WHERE id = $1`,
      [id]
    );
  });
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Model" (
      id INTEGER PRIMARY KEY, "userId" INTEGER, minor BOOLEAN NOT NULL DEFAULT false,
      nsfw BOOLEAN NOT NULL DEFAULT false, "sfwOnly" BOOLEAN NOT NULL DEFAULT false,
      poi BOOLEAN NOT NULL DEFAULT false, availability TEXT NOT NULL DEFAULT 'Public',
      "gallerySettings" JSONB, "lockedProperties" TEXT[] NOT NULL DEFAULT '{}', meta JSONB,
      status TEXT NOT NULL DEFAULT 'Published', "deletedAt" TIMESTAMP(3)
    );
    CREATE TABLE "Image" (id INTEGER PRIMARY KEY, minor BOOLEAN NOT NULL DEFAULT false);
    CREATE TABLE "ModActivity" (
      id SERIAL PRIMARY KEY, "userId" INTEGER, activity TEXT NOT NULL, "entityType" TEXT,
      "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
    );
  `);
});

afterEach(async () => {
  await holder.db.close();
});

describe('a rollback on a model that was minor before the flag', () => {
  const keptMinor = async () => {
    const report = await rollback();

    const after = await row();
    expect(after).toMatchObject({
      minor: true,
      nsfw: false,
      sfwOnly: true,
      gallerySettings: { level: sfwBrowsingLevelsFlag },
    });
    const meta = after.meta as Record<string, unknown>;
    expect(meta.minorFlagSnapshot).toBeUndefined();
    expect(meta.minorHashCleared).toBeDefined();
    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect(report).toMatchObject({ rolledBack: 1, keptMinor: 1, failed: 0 });
    return after;
  };

  it('keeps minor when the snapshot recorded it, and puts back only the locks from before', async () => {
    await seed({ snapshot: { ...sfwOnlyBefore, prevMinor: true, prevLockedProperties: ['tags'] } });

    const after = await keptMinor();

    expect(after.lockedProperties).toEqual(['tags']);
    expect(mockRestoreOwnerFlagOverride).not.toHaveBeenCalled();
    expect((await holder.db.query(`SELECT activity, "entityId" FROM "ModActivity"`)).rows).toEqual([
      { activity: 'rollbackMinorAutoHash', entityId: MODEL_ID },
    ]);
  });

  it("keeps an older snapshot's minor when the owner's override records declaring it", async () => {
    const ownerFlagOverride = {
      at: '2019-01-01T00:00:00Z',
      flags: ['minor'],
      prevNsfw: true,
      prevSfwOnly: false,
      prevLockedProperties: ['nsfw'],
    };
    await seed({ snapshot: mature, ownerFlagOverride });

    const after = await keptMinor();

    expect((after.meta as Record<string, unknown>).ownerFlagOverride).toEqual(ownerFlagOverride);
  });

  it("keeps an older snapshot's minor when it recorded a minor lock", async () => {
    await seed({ snapshot: { ...mature, prevLockedProperties: ['minor', 'nsfw', 'sfwOnly'] } });

    await keptMinor();
  });

  it("keeps an older snapshot's minor when it recorded an SFW-only model, and logs the model", async () => {
    await seed({ snapshot: sfwOnlyBefore });

    await keptMinor();

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'minor-hash-rollback', modelId: MODEL_ID }),
      'webhooks'
    );
  });

  it('counts it in a dry run without writing', async () => {
    await seed({ snapshot: { ...mature, prevMinor: true } });

    const report = await rollbackMinorHashAutoFlags({ dryRun: true, limit: 10 });

    expect(report).toMatchObject({ rolledBack: 1, keptMinor: 1 });
    expect((await row()).meta).toHaveProperty('minorFlagSnapshot');
  });
});

describe('a rollback on a model that was not minor before the flag', () => {
  it('unsets minor and puts back the mature rating it recorded', async () => {
    await seed({ snapshot: { ...mature, prevMinor: false } });

    const report = await rollback();

    expect(report).toMatchObject({ rolledBack: 1, failed: 0 });
    expect(mockSetModelMinor).toHaveBeenCalledTimes(1);
    expect(await row()).toMatchObject({
      minor: false,
      nsfw: true,
      sfwOnly: false,
      gallerySettings: { level: MATURE_LEVEL },
    });
  });

  it('unsets minor on an older snapshot that recorded a mature model', async () => {
    await seed({ snapshot: mature });

    await rollback();

    expect(await row()).toMatchObject({ minor: false, nsfw: true });
  });

  // An SFW-only pre-state that the snapshot says was not minor is just an SFW-only model.
  it('unsets minor when the snapshot recorded an SFW-only model that was not minor', async () => {
    await seed({ snapshot: { ...sfwOnlyBefore, prevMinor: false } });

    await rollback();

    expect(await row()).toMatchObject({ minor: false, sfwOnly: true });
  });

  it.each([
    ['a real-person model', { poi: true }],
    ['a private model', { availability: 'Private' }],
  ])('leaves %s SFW-only at the level the flag set', async (_, model) => {
    await seed({
      ...model,
      snapshot: { ...mature, prevMinor: false, prevLockedProperties: ['tags'] },
    });

    await rollback();

    expect(await row()).toMatchObject({
      minor: false,
      nsfw: false,
      sfwOnly: true,
      gallerySettings: { level: sfwBrowsingLevelsFlag },
      lockedProperties: ['tags'],
    });
  });
});
