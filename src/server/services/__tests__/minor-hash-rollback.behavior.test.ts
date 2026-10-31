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

const query = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
  (await run(strings, values)).rows) as never;
dbMock.dbWrite.$executeRaw.mockImplementation(
  (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await run(strings, values)).affectedRows ?? 0) as never
);
dbMock.dbRead.$queryRaw.mockImplementation(query);
dbMock.dbWrite.$queryRaw.mockImplementation(query);

const { rollbackMinorHashAutoFlags, revertMinorHashAutoFlag } = await import(
  '~/server/services/minor-hash.service'
);

const MODEL_ID = 1;
const MODERATOR_ID = 7;
const MATURE_LEVEL = 31;
const MINOR_LOCKS = ['minor', 'nsfw', 'sfwOnly'];

type Seed = {
  poi?: boolean;
  availability?: string;
  snapshot: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

// A model as an automated flag leaves it: minor, SFW-only at the SFW level, with the minor locks.
async function seed({ poi = false, availability = 'Public', snapshot, meta }: Seed) {
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
        ...meta,
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
const sorted = (locks: unknown) => [...(locks as string[])].sort();

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
    expect(mockRestoreOwnerFlagOverride).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      rolledBack: 0,
      keptMinor: 1,
      failed: 0,
      sample: [{ modelId: MODEL_ID, outcome: 'keptMinor' }],
    });
    return after;
  };

  it('keeps minor when the snapshot recorded it, and puts back only the locks from before', async () => {
    await seed({
      snapshot: { ...sfwOnlyBefore, prevMinor: true, prevLockedProperties: ['tags'] },
      meta: { systemNsfwLock: { at: '2020-01-01T00:00:00Z' } },
    });
    await holder.db.query(`INSERT INTO "Image" (id, minor) VALUES (5, true)`);

    const after = await keptMinor();

    expect(after.lockedProperties).toEqual(['tags']);
    expect(after.meta).not.toHaveProperty('systemNsfwLock');
    expect((await holder.db.query(`SELECT minor FROM "Image" WHERE id = 5`)).rows).toEqual([
      { minor: true },
    ]);
    expect((await holder.db.query(`SELECT activity, "entityId" FROM "ModActivity"`)).rows).toEqual([
      { activity: 'rollbackMinorAutoHash', entityId: MODEL_ID },
    ]);
  });

  it("keeps an older snapshot's minor, the owner's override and the old locks when the override declares minor", async () => {
    const ownerFlagOverride = {
      at: '2019-01-01T00:00:00Z',
      flags: ['minor'],
      prevNsfw: true,
      prevSfwOnly: false,
      prevLockedProperties: ['nsfw'],
    };
    await seed({
      snapshot: { ...mature, prevLockedProperties: ['tags'] },
      meta: { ownerFlagOverride },
    });

    const after = await keptMinor();

    expect((after.meta as Record<string, unknown>).ownerFlagOverride).toEqual(ownerFlagOverride);
    expect(after.lockedProperties).toEqual(['tags']);
  });

  // Only a moderator can clear a minor flag kept on inference.
  it.each([
    ['a minor lock', { ...mature, prevLockedProperties: ['minor', 'tags'] }],
    ['an SFW-only model', { ...sfwOnlyBefore, prevLockedProperties: ['tags'] }],
  ])(
    "keeps an older snapshot's minor and the minor locks when it recorded %s",
    async (_, snapshot) => {
      await seed({ snapshot });

      const after = await keptMinor();

      expect(sorted(after.lockedProperties)).toEqual(sorted([...MINOR_LOCKS, 'tags']));
    }
  );

  it('logs the model when only the SFW-only state kept minor', async () => {
    await seed({ snapshot: sfwOnlyBefore });

    await keptMinor();

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'minor-hash-rollback', modelId: MODEL_ID }),
      'webhooks'
    );
  });

  it('keeps the real-person locks in the same write, and reasserts the restrictions', async () => {
    await seed({ poi: true, snapshot: { ...sfwOnlyBefore, prevMinor: true } });

    const after = await keptMinor();

    expect(sorted(after.lockedProperties)).toEqual(['nsfw', 'poi', 'sfwOnly']);
    expect(mockReassertPoi).toHaveBeenCalledWith(MODEL_ID);
  });

  it('counts it in a dry run without writing', async () => {
    await seed({ snapshot: { ...mature, prevMinor: true } });

    const report = await rollbackMinorHashAutoFlags({ dryRun: true, limit: 10 });

    expect(report).toMatchObject({ rolledBack: 0, keptMinor: 1 });
    expect((await row()).meta).toHaveProperty('minorFlagSnapshot');
  });
});

describe('a rollback on a model that was not minor before the flag', () => {
  const unset = async () => {
    const report = await rollback();
    expect(report).toMatchObject({ rolledBack: 1, keptMinor: 0, failed: 0 });
    expect(mockSetModelMinor).toHaveBeenCalledTimes(1);
    return row();
  };

  it('unsets minor and puts back the mature rating it recorded', async () => {
    await seed({ snapshot: { ...mature, prevMinor: false } });

    expect(await unset()).toMatchObject({
      minor: false,
      nsfw: true,
      sfwOnly: false,
      gallerySettings: { level: MATURE_LEVEL },
    });
  });

  it.each([
    ['a mature model', mature],
    // Mature and SFW-only is not the state a minor flag leaves.
    ['a mature, SFW-only model', { ...mature, prevSfwOnly: true }],
  ])('unsets minor on an older snapshot that recorded %s', async (_, snapshot) => {
    await seed({ snapshot });

    expect(await unset()).toMatchObject({ minor: false, nsfw: true });
  });

  // An SFW-only pre-state that the snapshot says was not minor is just an SFW-only model.
  it('unsets minor when the snapshot recorded an SFW-only model that was not minor', async () => {
    await seed({ snapshot: { ...sfwOnlyBefore, prevMinor: false } });

    expect(await unset()).toMatchObject({ minor: false, sfwOnly: true });
  });

  it.each([
    ['a real-person model', { poi: true }, ['nsfw', 'poi', 'sfwOnly', 'tags']],
    ['a private model', { availability: 'Private' }, ['tags']],
  ])('leaves %s SFW-only at the level the flag set', async (_, model, locks) => {
    await seed({
      ...model,
      snapshot: { ...mature, prevMinor: false, prevLockedProperties: ['tags'] },
    });

    const after = await unset();

    expect(after).toMatchObject({
      minor: false,
      nsfw: false,
      sfwOnly: true,
      gallerySettings: { level: sfwBrowsingLevelsFlag },
    });
    expect(sorted(after.lockedProperties)).toEqual(locks);
  });
});

describe('a moderator revert of a minor flag', () => {
  const revert = () => revertMinorHashAutoFlag({ modelId: MODEL_ID, userId: MODERATOR_ID });

  it.each(['auto', 'text-scan'])('undoes a %s flag', async (source) => {
    await seed({ snapshot: { ...mature, prevMinor: false, source } });

    expect(await revert()).toMatchObject({ rolledBack: 1 });
    expect(await row()).toMatchObject({ minor: false });
  });

  it("refuses a moderator's own flag", async () => {
    await seed({ snapshot: { ...mature, prevMinor: false, source: 'manual' } });

    await expect(revert()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await row()).toMatchObject({ minor: true });
  });

  it.each([
    ['refuses', 'after', '+ 1 hour', true],
    ['still undoes', 'before', '- 1 hour', false],
  ])('%s an automated flag a moderator set minor on %s it', async (_, __, offset, refused) => {
    await seed({ snapshot: { ...mature, prevMinor: false, at: '2020-01-01T00:00:00Z' } });
    await holder.db.query(
      `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
       VALUES ($1, 'setMinor', 'model', $2, '2020-01-01T00:00:00Z'::timestamp ${
         offset[0]
       } interval '${offset.slice(2)}')`,
      [MODERATOR_ID, MODEL_ID]
    );

    if (refused) await expect(revert()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    else await revert();

    expect(await row()).toMatchObject({ minor: refused });
  });
});
