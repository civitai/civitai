import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as PgDb from '~/server/db/pgDb';
import type * as ModelService from '~/server/services/model.service';
import type * as ModeratorService from '~/server/services/moderator.service';

/**
 * Which re-uploads of a real-person model get the flag, which wait for a moderator, and which are
 * left alone, on the real seed SQL. The flag write itself is `setModelPoi`'s job and is faked here.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const { setModelPoi } = vi.hoisted(() => ({
  setModelPoi: vi.fn(
    async ({
      id,
      poi = true,
      onlyIf,
    }: {
      id: number;
      poi?: boolean;
      onlyIf?: (row: Record<string, unknown>) => boolean;
    }) => {
      const { rows } = await holder.db.query<Record<string, unknown>>(
        `SELECT * FROM "Model" WHERE id = $1`,
        [id]
      );
      if (onlyIf && !onlyIf(rows[0])) return null;
      await holder.db.query(`UPDATE "Model" SET poi = $2 WHERE id = $1`, [id, poi]);
      return { id };
    }
  ),
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  setModelPoi,
}));
// The sweep reads through queryWithTimeout on the replica pg pool: route that pool's client to PGlite and keep
// what it was sent. `failOn` makes a statement throw, as a timeout would.
const pool = vi.hoisted(() => ({
  sent: [] as string[],
  failOn: null as RegExp | null,
}));
vi.mock('~/server/db/pgDb', async (importOriginal) => ({
  ...(await importOriginal<typeof PgDb>()),
  pgDbRead: {
    connect: async () => ({
      query: async (q: string | { text: string; values: unknown[] }, values?: unknown[]) => {
        const text = typeof q === 'string' ? q : q.text;
        pool.sent.push(text);
        if (pool.failOn?.test(text))
          throw Object.assign(new Error('canceling statement due to statement timeout'), {
            code: '57014',
          });
        return holder.db.query(text, typeof q === 'string' ? values : q.values);
      },
      release: () => undefined,
    }),
  },
}));
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateModelNsfwLevels: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({
  bustPublicModelResponseCache: vi.fn(),
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: vi.fn(async () => undefined),
}));

const {
  checkPoiHashOnScan,
  confirmPoiHashAutoFlag,
  dismissPoiHashMatch,
  findPoiHashSeeds,
  flagPoiHashMatch,
  revertPoiHashAutoFlag,
  sweepPoiHashMatches,
} = await import('~/server/services/poi-hash.service');

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
      minor bool NOT NULL DEFAULT false, nsfw bool NOT NULL DEFAULT false,
      "sfwOnly" bool NOT NULL DEFAULT false, "gallerySettings" jsonb,
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
  pool.sent = [];
  pool.failOn = null;
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

  // An owner's save can race the snapshot away; who set the flag last still says it was automation.
  it('a flag this feature applied does not seed even without its snapshot, until a moderator confirms', async () => {
    await addModel(51, 6, `poi = true, "lockedProperties" = ${LOCKED}`);
    await addFile(51, 'LOST', '30 days');
    await pg.exec(
      `INSERT INTO "ModActivity" (activity, "entityType", "entityId") VALUES ('setPoiAutoHash', 'model', 51)`
    );
    expect(await findPoiHashSeeds('LOST')).toEqual([]);
    await pg.exec(
      `INSERT INTO "ModActivity" (activity, "entityType", "entityId", "createdAt") VALUES ('setPoi', 'model', 51, now() + interval '1 second')`
    );
    expect(await findPoiHashSeeds('LOST')).toEqual([{ modelId: 51, userId: 6, human: true }]);
  });

  it('a moderator set from before the current text-scan verdict does not make it human', async () => {
    await pg.exec(`
      UPDATE "Model" SET meta = '{"textScanFlags":{"poi":{"workflowId":"w","at":"2026-06-01T00:00:00Z"}}}'
      WHERE id = ${SCAN_SEED};
      INSERT INTO "ModActivity" (activity, "entityType", "entityId", "createdAt")
      VALUES ('setPoi', 'model', ${SCAN_SEED}, '2026-01-01');
    `);
    expect(await findPoiHashSeeds('SCAN')).toEqual([
      { modelId: SCAN_SEED, userId: 2, human: false },
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

  it('reads a cutoff an operator wrote as a date, and fails closed on one it cannot read', async () => {
    await pg.exec(
      `UPDATE "KeyValue" SET value = to_jsonb(to_char((now() - interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))`
    );
    await addModel(22, 1);
    expect(await scan(22, 1, await addFile(22, 'MOD'), 'MOD')).toBe('flagged');

    await pg.exec(`UPDATE "KeyValue" SET value = '"not a date"'`);
    await addModel(23, 1);
    expect(await scan(23, 1, await addFile(23, 'MOD'), 'MOD')).toBe('skipped');
    // The job failure has to tell an operator which row to fix.
    await expect(sweepPoiHashMatches({ limit: 50 })).rejects.toThrow('poi-hash-match-since');
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

describe('sweepPoiHashMatches — the read', () => {
  it('counts every candidate even when the batch is smaller, from the same single read', async () => {
    for (const id of [61, 62, 63]) {
      await addModel(id, 1);
      await addFile(id, 'MOD', '5 minutes');
    }

    const report = await sweepPoiHashMatches({ limit: 1 });

    expect(report).toMatchObject({ candidates: 3, flagged: 1, backlog: 0 });
    expect(pool.sent.filter((text) => text.includes('seed_models'))).toHaveLength(1);
  });

  // The counts are the queue-volume figure moderation reads; a model nothing seeds is not a candidate.
  it('counts no copy of a model whose flag does not seed', async () => {
    await addModel(66, 4);
    await addFile(66, 'SELF', '5 minutes');
    await addModel(67, 5);
    await addFile(67, 'AUTO', '5 minutes');

    expect(await sweepPoiHashMatches({ limit: 50 })).toMatchObject({ candidates: 0, backlog: 0 });
  });

  it('with only pre-cutoff copies, reports the backlog and acts on nothing', async () => {
    await addModel(64, 1);
    await addFile(64, 'MOD', '2 hours');

    const report = await sweepPoiHashMatches({ limit: 50 });

    expect(report).toMatchObject({ candidates: 0, flagged: 0, queued: 0, failed: 0, backlog: 1 });
    expect(setModelPoi).not.toHaveBeenCalled();
  });

  it('runs read-only under its own 120s ceiling', async () => {
    await sweepPoiHashMatches({ limit: 50 });
    const at = pool.sent.findIndex((text) => text.includes('seed_models'));
    expect(pool.sent.slice(0, at)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 120000',
    ]);
  });

  // A swallowed timeout would read as "nothing to do" every night while copies go unmatched.
  it('a timeout fails the run loudly and writes nothing', async () => {
    await addModel(65, 1);
    await addFile(65, 'MOD', '5 minutes');
    pool.failOn = /seed_models/;
    loggingMock.logToAxiom.mockClear();

    await expect(sweepPoiHashMatches({ limit: 50 })).rejects.toMatchObject({ code: '57014' });

    expect(setModelPoi).not.toHaveBeenCalled();
    expect(await meta(65)).toEqual({});
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'poi-hash-sweep' }),
      'webhooks'
    );
  });
});

describe('revertPoiHashAutoFlag — the system nsfw lock marker', () => {
  const REVERTED = 60;
  const snapshotMeta = (extra: Record<string, unknown>) =>
    JSON.stringify({
      poiFlagSnapshot: {
        source: 'auto',
        prevNsfw: true,
        prevSfwOnly: false,
        prevLockedProperties: ['nsfw'],
      },
      systemNsfwLock: { source: 'text-scan', at: '2026-09-01T00:00:00Z' },
      ...extra,
    });

  it('drops the marker when it restores the prior locks, and keeps the other keys', async () => {
    await addModel(
      REVERTED,
      6,
      `poi = true, nsfw = false, "lockedProperties" = ${LOCKED}, meta = '${snapshotMeta({
        cannotPromote: true,
      })}'`
    );

    await revertPoiHashAutoFlag({ modelId: REVERTED, userId: 99 });

    const m = await meta(REVERTED);
    expect(m).not.toHaveProperty('systemNsfwLock');
    expect(m).toHaveProperty('cannotPromote', true);
  });

  // The restore moves sfwOnly and the gallery level after setModelPoi, which saw neither change.
  it("drops the model's cached gallery settings after the restore", async () => {
    await addModel(
      REVERTED,
      6,
      `poi = true, "sfwOnly" = true, "lockedProperties" = ${LOCKED}, meta = '${snapshotMeta({})}'`
    );
    redisMock.redis.del.mockClear();

    await revertPoiHashAutoFlag({ modelId: REVERTED, userId: 99 });

    expect(redisMock.redis.del).toHaveBeenCalledWith([`model:gallery-settings:${REVERTED}`]);
  });

  it('drops the marker on a model that keeps its minor restrictions', async () => {
    await addModel(
      REVERTED,
      6,
      `poi = true, minor = true, "lockedProperties" = ${LOCKED}, meta = '${snapshotMeta({})}'`
    );

    await revertPoiHashAutoFlag({ modelId: REVERTED, userId: 99 });

    expect(await meta(REVERTED)).not.toHaveProperty('systemNsfwLock');
  });
});

describe('the moderator queue rules only a flag still as the hash match applied it', () => {
  const MODEL = 70;
  const flagged = (snapshot: Record<string, unknown>) =>
    addModel(
      MODEL,
      7,
      `poi = true, "lockedProperties" = ${LOCKED}, meta = '${JSON.stringify({
        poiFlagSnapshot: {
          at: '2026-10-01T00:00:00Z',
          prevNsfw: true,
          prevSfwOnly: false,
          ...snapshot,
        },
      })}'`
    );
  const lifts = () => setModelPoi.mock.calls.filter(([input]) => input.poi === false).length;
  const confirmedSnapshot = { source: 'manual', confirmedFrom: 'auto' };

  it('confirms and reverts an unconfirmed hash flag', async () => {
    await flagged({ source: 'auto' });
    expect(await confirmPoiHashAutoFlag({ modelId: MODEL, userId: 99 })).toEqual({
      confirmed: 1,
    });

    await pg.exec(`DELETE FROM "Model" WHERE id = ${MODEL}`);
    await flagged({ source: 'auto' });
    expect(await revertPoiHashAutoFlag({ modelId: MODEL, userId: 99 })).toEqual({
      reverted: 1,
    });
    expect(lifts()).toBe(1);
  });

  it('refuses a flag a moderator already confirmed', async () => {
    await flagged(confirmedSnapshot);
    expect(await confirmPoiHashAutoFlag({ modelId: MODEL, userId: 99 })).toEqual({
      confirmed: 0,
    });
    expect(await revertPoiHashAutoFlag({ modelId: MODEL, userId: 99 })).toEqual({
      reverted: 0,
    });
    expect(lifts()).toBe(0);
    expect(await meta(MODEL)).toMatchObject({ poiFlagSnapshot: confirmedSnapshot });
  });

  // set-poi by hand on an auto-flagged model keeps the auto snapshot; the queue drops the row, so a
  // stale page's Revert must not lift the moderator's flag.
  it('refuses a flag a moderator set by hand since', async () => {
    await flagged({ source: 'auto' });
    await pg.query(
      `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
       VALUES (5, 'setPoi', 'model', $1, '2026-10-02T00:00:00Z')`,
      [MODEL]
    );
    expect(await revertPoiHashAutoFlag({ modelId: MODEL, userId: 99 })).toEqual({
      reverted: 0,
    });
    expect(await confirmPoiHashAutoFlag({ modelId: MODEL, userId: 99 })).toEqual({
      confirmed: 0,
    });
  });

  // Both moderators would be told they succeeded, and the confirmed model would get its pre-flag
  // nsfw rating back.
  it('a confirm landing between the read and the lock stops the revert', async () => {
    await flagged({ source: 'auto' });
    const lift = setModelPoi.getMockImplementation()!;
    setModelPoi.mockImplementationOnce(async (input) => {
      await confirmPoiHashAutoFlag({ modelId: MODEL, userId: 5 });
      return lift(input);
    });

    expect(await revertPoiHashAutoFlag({ modelId: MODEL, userId: 99 })).toEqual({ reverted: 0 });
    const [row] = (
      await pg.query<{ poi: boolean; nsfw: boolean }>(
        `SELECT poi, nsfw FROM "Model" WHERE id = $1`,
        [MODEL]
      )
    ).rows;
    expect(row).toEqual({ poi: true, nsfw: false });
  });

  // An appeal against a confirmed hash flag must still roll it back: resolveMinorFlagAppeal passes
  // fromAppeal. Without it the queue's rule would leave a granted appeal's flag in place.
  it('an appeal still reverts a confirmed hash flag', async () => {
    await flagged(confirmedSnapshot);
    expect(await revertPoiHashAutoFlag({ modelId: MODEL, userId: 99, fromAppeal: true })).toEqual({
      reverted: 1,
    });
    expect(lifts()).toBe(1);
  });
});

describe('flagPoiHashMatch — only a model still waiting on its match', () => {
  const MODEL = 80;
  const lead = `meta = '{"poiHashMatch":{"at":"2026-10-01T00:00:00Z","hash":"ABC"}}'`;

  it('flags it', async () => {
    await addModel(MODEL, 8, lead);
    expect(await flagPoiHashMatch({ modelId: MODEL, userId: 99 })).toEqual({ flagged: 1 });
  });

  it.each([
    ['the lead was dismissed', ''],
    ['the model is already flagged', `${lead}, poi = true`],
    ['the model was deleted', `${lead}, status = 'Deleted'`],
  ])('flags nothing when %s', async (_, sql) => {
    await addModel(MODEL, 8, sql);
    expect(await flagPoiHashMatch({ modelId: MODEL, userId: 99 })).toEqual({ flagged: 0 });
  });

  // A dismiss queued behind a flag's lock would otherwise report a lead the flag already settled.
  it('a dismiss on a flagged model dismisses nothing', async () => {
    await addModel(MODEL, 8, `${lead}, poi = true`);
    expect(await dismissPoiHashMatch({ modelId: MODEL, userId: 99 })).toEqual({ dismissed: 0 });
  });
});
