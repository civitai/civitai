import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as ModelService from '~/server/services/model.service';
import type * as ModeratorService from '~/server/services/moderator.service';

/**
 * Which re-uploads of a real-person model get the flag, which wait for a moderator, and which are
 * left alone, on the real seed SQL. The flag write itself is `setModelPoi`'s job and is faked here.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const { setModelPoi } = vi.hoisted(() => ({
  setModelPoi: vi.fn(async ({ id }: { id: number }) => {
    await holder.db.query(`UPDATE "Model" SET poi = true WHERE id = $1`, [id]);
  }),
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  setModelPoi,
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: vi.fn(async () => undefined),
}));

const { checkPoiHashOnScan, dismissPoiHashMatch, findPoiHashSeeds, sweepPoiHashMatches } =
  await import('~/server/services/poi-hash.service');

const MOD_SEED = 10; // owner 1, set by a moderator: no text-scan entry, no setPoi row
const SCAN_SEED = 20; // owner 2, an unruled text-scan verdict
const UPHELD_SEED = 30; // owner 3, a text-scan verdict a moderator kept
const SELF_DECLARED = 40; // owner 4, poi but never locked
const AUTO_SEED = 50; // owner 5, applied by this feature and never confirmed

const LOCKED = `'{poi,nsfw,sfwOnly}'`;
let pg: PGlite;
let fileId = 1000;

beforeAll(async () => {
  pg = new PGlite();
  holder.db = pg;
  await pg.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int, poi bool NOT NULL DEFAULT false,
      "lockedProperties" text[] NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'Published',
      meta jsonb);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int);
    CREATE TABLE "ModelFile" (id int PRIMARY KEY, "modelVersionId" int, type text,
      "createdAt" timestamp(3) NOT NULL);
    CREATE TABLE "ModelFileHash" ("fileId" int, type text, hash text);
    CREATE TABLE "ModActivity" (id serial, "userId" int, activity text, "entityType" text,
      "entityId" int, "createdAt" timestamp(3) DEFAULT now());
    CREATE TABLE "KeyValue" (key text PRIMARY KEY, value jsonb NOT NULL);
  `);
  const raw = pgliteRaw(pg);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
    client.$executeRaw.mockImplementation(raw.executeRaw as never);
  }
});

const addModel = async (id: number, userId: number, sql = '') =>
  pg
    .query(
      `INSERT INTO "Model" (id, "userId", poi, "lockedProperties", meta) VALUES ($1, $2, false, '{}', '{}')`,
      [id, userId]
    )
    .then(() => (sql ? pg.exec(`UPDATE "Model" SET ${sql} WHERE id = ${id}`) : undefined));

/** A main-weights file on the model carrying `hash`, uploaded `ago` before now. */
const addFile = async (modelId: number, hash: string, ago = '1 minute') => {
  const id = ++fileId;
  await pg.query(
    `INSERT INTO "ModelVersion" (id, "modelId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [modelId, modelId]
  );
  await pg.query(`INSERT INTO "ModelFile" VALUES ($1, $2, 'Model', now() - $3::interval)`, [
    id,
    modelId,
    ago,
  ]);
  await pg.query(`INSERT INTO "ModelFileHash" VALUES ($1, 'SHA256', $2)`, [id, hash]);
  return id;
};

const meta = async (id: number) =>
  (
    await pg.query<{ meta: Record<string, unknown> }>(`SELECT meta FROM "Model" WHERE id = $1`, [
      id,
    ])
  ).rows[0].meta;

const scan = (modelId: number, userId: number, fileId: number, sha256: string) =>
  checkPoiHashOnScan({ modelId, userId, fileId, sha256 });

beforeEach(async () => {
  setModelPoi.mockClear();
  await pg.exec(
    `TRUNCATE "Model", "ModelVersion", "ModelFile", "ModelFileHash", "ModActivity", "KeyValue"`
  );
  // A cutoff an hour back: files uploaded before it are never matched.
  await pg.exec(`INSERT INTO "KeyValue" VALUES ('poi-hash-match-since',
    to_jsonb((extract(epoch FROM now() - interval '1 hour') * 1000)::bigint))`);
  dbMock.dbWrite.keyValue.findUnique.mockImplementation(
    (async () =>
      (await pg.query(`SELECT * FROM "KeyValue" WHERE key = 'poi-hash-match-since'`))
        .rows[0]) as never
  );

  await addModel(MOD_SEED, 1, `poi = true, "lockedProperties" = ${LOCKED}`);
  await addModel(
    SCAN_SEED,
    2,
    `poi = true, "lockedProperties" = ${LOCKED}, meta = '{"textScanFlags":{"poi":{"workflowId":"w"}}}'`
  );
  await addModel(
    UPHELD_SEED,
    3,
    `poi = true, "lockedProperties" = ${LOCKED},
     meta = '{"textScanFlags":{"poi":{"workflowId":"w","appealUpheld":{"at":"2026-01-01"}}}}'`
  );
  await addModel(SELF_DECLARED, 4, `poi = true`);
  await addModel(
    AUTO_SEED,
    5,
    `poi = true, "lockedProperties" = ${LOCKED}, meta = '{"poiFlagSnapshot":{"source":"auto"}}'`
  );
  for (const [id, hash] of [
    [MOD_SEED, 'MOD'],
    [SCAN_SEED, 'SCAN'],
    [UPHELD_SEED, 'UPHELD'],
    [SELF_DECLARED, 'SELF'],
    [AUTO_SEED, 'AUTO'],
  ] as const)
    await addFile(id, hash, '30 days');
});

describe('findPoiHashSeeds', () => {
  it('a mod-set flag with no text-scan record is a human seed', async () => {
    expect(await findPoiHashSeeds('mod')).toEqual([{ modelId: MOD_SEED, userId: 1, human: true }]);
  });

  it('an unruled text-scan verdict seeds as machine-only; one a moderator kept is human', async () => {
    expect(await findPoiHashSeeds('SCAN')).toEqual([
      { modelId: SCAN_SEED, userId: 2, human: false },
    ]);
    expect(await findPoiHashSeeds('UPHELD')).toEqual([
      { modelId: UPHELD_SEED, userId: 3, human: true },
    ]);
  });

  it('a moderator setting the flag by hand makes a text-scan seed human', async () => {
    await pg.exec(
      `INSERT INTO "ModActivity" (activity, "entityType", "entityId") VALUES ('setPoi', 'model', ${SCAN_SEED})`
    );
    expect(await findPoiHashSeeds('SCAN')).toEqual([
      { modelId: SCAN_SEED, userId: 2, human: true },
    ]);
  });

  it('a self-declared flag and an unconfirmed hash flag never seed', async () => {
    expect(await findPoiHashSeeds('SELF')).toEqual([]);
    expect(await findPoiHashSeeds('AUTO')).toEqual([]);
  });
});

describe('checkPoiHashOnScan', () => {
  it('the same owner re-uploading a human-seeded model gets the flag', async () => {
    await addModel(11, 1);
    expect(await scan(11, 1, await addFile(11, 'MOD'), 'mod')).toBe('flagged');
    expect(setModelPoi).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11, poi: true, activity: 'setPoiAutoHash' })
    );
  });

  it('a machine-only seed never applies the flag, even for the same owner: it queues', async () => {
    await addModel(21, 2);
    expect(await scan(21, 2, await addFile(21, 'SCAN'), 'SCAN')).toBe('queued');
    expect(setModelPoi).not.toHaveBeenCalled();
    expect(await meta(21)).toMatchObject({ poiHashMatch: { hash: 'SCAN' } });
  });

  it('another uploader copying a human seed is queued, never flagged', async () => {
    await addModel(12, 99);
    expect(await scan(12, 99, await addFile(12, 'MOD'), 'MOD')).toBe('queued');
    expect(setModelPoi).not.toHaveBeenCalled();
  });

  it("an owner's re-upload of a model with no locked flag is untouched", async () => {
    await addModel(41, 4);
    expect(await scan(41, 4, await addFile(41, 'SELF'), 'SELF')).toBe('skipped');
    expect(await meta(41)).toEqual({});
  });

  it('a file uploaded before the cutoff is never matched', async () => {
    await addModel(13, 1);
    expect(await scan(13, 1, await addFile(13, 'MOD', '2 hours'), 'MOD')).toBe('skipped');
    expect(setModelPoi).not.toHaveBeenCalled();
  });

  it('a moderator clearing the model stops older files re-flagging; a newer upload still matches', async () => {
    await addModel(14, 1);
    const older = await addFile(14, 'MOD', '10 minutes');
    await pg.exec(
      `UPDATE "Model" SET meta = jsonb_build_object('poiHashCleared', jsonb_build_object('at', now() - interval '5 minutes')) WHERE id = 14`
    );
    expect(await scan(14, 1, older, 'MOD')).toBe('skipped');
    expect(await scan(14, 1, await addFile(14, 'MOD', '1 minute'), 'MOD')).toBe('flagged');
  });

  it('a dismissed match does not come back for the same file', async () => {
    await addModel(15, 99);
    const file = await addFile(15, 'MOD', '1 minute');
    expect(await scan(15, 99, file, 'MOD')).toBe('queued');
    expect(await dismissPoiHashMatch({ modelId: 15, userId: 7 })).toEqual({ dismissed: 1 });
    expect(await meta(15)).not.toHaveProperty('poiHashMatch');
    expect(await scan(15, 99, file, 'MOD')).toBe('skipped');
  });

  it('stamps the cutoff on the first enabled scan when none is set', async () => {
    await pg.exec(`TRUNCATE "KeyValue"`);
    await addModel(16, 1);
    // Uploaded before the switch went on: the stamp lands after it, so it is not matched.
    expect(await scan(16, 1, await addFile(16, 'MOD', '1 minute'), 'MOD')).toBe('skipped');
    const rows = (await pg.query(`SELECT 1 FROM "KeyValue" WHERE key = 'poi-hash-match-since'`))
      .rows;
    expect(rows).toHaveLength(1);
  });
});

describe('sweepPoiHashMatches', () => {
  it('acts on copies after the cutoff, including a model with no meta at all, and only counts older ones', async () => {
    await addModel(17, 1, 'meta = NULL');
    await addFile(17, 'MOD', '5 minutes');
    await addModel(18, 99);
    await addFile(18, 'MOD', '5 minutes');
    await addModel(19, 1);
    await addFile(19, 'MOD', '2 hours');

    const report = await sweepPoiHashMatches({ limit: 50 });

    expect(report).toMatchObject({ candidates: 2, flagged: 1, queued: 1, failed: 0, backlog: 1 });
    expect(setModelPoi).toHaveBeenCalledWith(expect.objectContaining({ id: 17 }));
    expect(await meta(18)).toMatchObject({ poiHashMatch: { hash: 'MOD' } });
    expect(await meta(19)).toEqual({});
  });
});
