import { describe, expect, it, vi } from 'vitest';
import { deserializeTrainImageIds } from '~/server/services/resource-intent-cooc/build';
import type { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { COOC_STATEMENT_TIMEOUT_MS } from '~/server/services/resource-intent-cooc/build';
import {
  buildCoocSnapshot,
  defaultCoocTrainEnd,
} from '~/server/services/resource-intent-cooc/pipeline';
import { RESOURCE_INTENT_COOC_SPEC } from '~/server/services/resource-intent-cooc/spec';
import { loadCoocSnapshot } from '~/server/services/resource-intent-cooc/store';
import { fakeImageDb, freshDb } from './resource-intent-cooc.harness';

vi.setConfig({ testTimeout: 60_000 });

const DAY = 86_400_000;
// Fixed, for the date-derived expectations (train window, UTC train end). Never measure a
// persisted study pin from it: the CHECK measures the pin from `builtAt`, which the database
// stamps with its own clock, so a pin fixed relative to NOW expires once the wall clock passes it.
const NOW = new Date('2026-10-01T12:34:56.789Z');
const SEED = RESOURCE_INTENT_COOC_SPEC.defaultSeed;
const PROD_TRAIN_END = new Date('2026-09-30T00:00:00.000Z');

function imageDb(
  extra: Partial<Parameters<typeof fakeImageDb>[0]> = {},
  trainEnd = PROD_TRAIN_END
) {
  return fakeImageDb({
    trainStart: new Date(trainEnd.getTime() - RESOURCE_INTENT_COOC_SPEC.trainDays * DAY),
    trainEnd,
    images: 900,
    ...extra,
  });
}
const production = (over: Partial<Parameters<typeof buildCoocSnapshot>[0]> = {}) => ({
  kind: 'production' as const,
  seed: SEED,
  pinnedUntil: null,
  dryRun: false,
  checkpointSection: false,
  now: NOW,
  ...over,
});

describe('cooc build pipeline', () => {
  it('a production build lands one ready row with the drawn training metadata', async () => {
    const { db, sql } = await freshDb();
    const images = imageDb();
    const s = await buildCoocSnapshot({ ...production(), query: images.query, sql });
    expect(s.trainEnd).toBe('2026-09-30T00:00:00.000Z');
    expect(s.trainStart).toBe('2026-06-02T00:00:00.000Z');
    expect([s.trainRows, s.idsTried, s.created]).toEqual([900, 900, true]);
    const [row] = (
      await db.query<{
        status: string;
        kind: string;
        contentHash: string;
        trainRows: number;
        idsTried: number;
        vocab: number;
        keptPairs: number;
        trainCreatedAtMin: Date;
        trainCreatedAtMax: Date;
        trainImageIds: Uint8Array;
      }>(`SELECT * FROM "ResourceIntentCoocSnapshot"`)
    ).rows;
    expect(row).toMatchObject({
      status: 'ready',
      kind: 'production',
      contentHash: s.contentHash,
      trainRows: 900,
      idsTried: 900,
      vocab: s.vocab,
      keptPairs: s.keptPairs,
    });
    expect(row.trainCreatedAtMin.getTime()).toBe(images.createdAt(1).getTime());
    expect(row.trainCreatedAtMax.getTime()).toBe(images.createdAt(900).getTime());
    expect(await deserializeTrainImageIds(row.trainImageIds)).toEqual(
      Array.from({ length: 900 }, (_, i) => i + 1)
    );

    const c = (await loadCoocSnapshot(sql, s.contentHash, { kind: 'production', now: NOW })).counts;
    expect(c.N).toBe(900);
    // Own-model tokens are removed in training. "rare0" (version 2000's trigger) appears only on
    // images attaching model 1000, so it is removed everywhere, while "rare4", also only on
    // model-1000 images, is kept and pairs with model 1000. 'model', 'checkpoint' and 'ctrl' share
    // their 23 images, all attaching model 1001 ("Model 2001", the only attachment whose name has
    // "model") and the checkpoint ("Base Checkpoint"): the control token is kept, the two
    // attachment-name tokens are removed.
    expect(c.vocab).toContain('ctrl');
    expect(c.vocab).not.toContain('model');
    expect(c.vocab).not.toContain('checkpoint');
    expect(c.vocab).not.toContain('rare0');
    const t = c.vocab.indexOf('rare4');
    expect(t).toBeGreaterThanOrEqual(0);
    expect([...c.modelIdx.subarray(c.ptr[t], c.ptr[t + 1])]).toContain(c.modelIds.indexOf(1000));
    // Aggregates only: no token reaches the summary.
    expect(Object.values(s).join(' ')).not.toMatch(/tok0|shared|rare|\bmodel\b/);
  });

  it('two production builds on the same day draw the same window: the second is a duplicate', async () => {
    const { sql } = await freshDb();
    const a = await buildCoocSnapshot({
      ...production({ now: new Date('2026-10-01T01:00:00Z') }),
      query: imageDb().query,
      sql,
    });
    const b = await buildCoocSnapshot({
      ...production({ now: new Date('2026-10-01T23:00:00Z') }),
      query: imageDb().query,
      sql,
    });
    expect([a.created, b.created]).toEqual([true, false]);
    expect(b.contentHash).toBe(a.contentHash);
  });

  it('a dry run builds the same content and writes nothing', async () => {
    const { db, sql } = await freshDb();
    const dry = await buildCoocSnapshot({
      ...production({ dryRun: true }),
      query: imageDb().query,
      sql,
    });
    expect(dry.rowId).toBeNull();
    expect((await db.query(`SELECT 1 FROM "ResourceIntentCoocSnapshot"`)).rows).toEqual([]);
    const real = await buildCoocSnapshot({ ...production(), query: imageDb().query, sql });
    expect(real.contentHash).toBe(dry.contentHash);
  });

  it('a row exactly at trainStart is inside the window', async () => {
    const { db, sql } = await freshDb();
    const trainStart = new Date(
      PROD_TRAIN_END.getTime() - RESOURCE_INTENT_COOC_SPEC.trainDays * DAY
    );
    const injected = {
      imageId: 999_996,
      createdAt: trainStart,
      prompt: 'tok00001',
      att: [{ modelId: 1000, modelType: 'LORA', versionId: 2000 }],
    };
    const s = await buildCoocSnapshot({
      ...production(),
      query: imageDb({ injectFirstBatch: [injected] }).query,
      sql,
    });
    expect([s.trainRows, s.created]).toEqual([901, true]);
    const [row] = (
      await db.query<{ trainCreatedAtMin: Date }>(
        `SELECT "trainCreatedAtMin" FROM "ResourceIntentCoocSnapshot"`
      )
    ).rows;
    expect(row.trainCreatedAtMin.getTime()).toBe(trainStart.getTime());
  });

  it('a batch longer than the yield interval is tokenised in full', async () => {
    const { sql } = await freshDb();
    const s = await buildCoocSnapshot({
      ...production({ dryRun: true }),
      query: imageDb({ images: 2_345 }).query,
      sql,
    });
    expect([s.trainRows, s.batches]).toEqual([2_345, 1]);
  });

  it('the train end is the UTC date, whatever the process time zone', () => {
    const tz = process.env.TZ;
    try {
      for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
        process.env.TZ = zone;
        // A pool that ignores a runtime TZ change would make this test vacuous; fail instead.
        const localDay = new Date('2026-10-01T23:30:00Z').getDate();
        expect(localDay).toBe(zone === 'Pacific/Kiritimati' ? 2 : 1);
        // 23:30Z is already the next local day at +14; 00:30Z is still the previous one at -11.
        expect(defaultCoocTrainEnd(new Date('2026-10-01T23:30:00Z')).toISOString()).toBe(
          '2026-09-30T00:00:00.000Z'
        );
        expect(defaultCoocTrainEnd(new Date('2026-10-01T00:30:00Z')).toISOString()).toBe(
          '2026-09-30T00:00:00.000Z'
        );
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  describe('a build that fails leaves a failed row, never a ready one', () => {
    const inWindow = (imageId: number, createdAt: Date) => ({
      imageId,
      createdAt,
      prompt: 'tok00001',
      att: [{ modelId: 1000, modelType: 'LORA', versionId: 2000 }],
    });
    const cases: [string, Parameters<typeof imageDb>[0], RegExp][] = [
      [
        'a row at trainEnd',
        { injectFirstBatch: [inWindow(999_999, PROD_TRAIN_END)] },
        /outside the training window/,
      ],
      [
        'a row before trainStart',
        { injectFirstBatch: [inWindow(999_998, new Date(PROD_TRAIN_END.getTime() - 121 * DAY))] },
        /outside the training window/,
      ],
      [
        'a repeated image id',
        {
          injectFirstBatch: [
            inWindow(999_997, new Date(PROD_TRAIN_END.getTime() - DAY)),
            inWindow(999_997, new Date(PROD_TRAIN_END.getTime() - DAY)),
          ],
        },
        /ids repeat/,
      ],
      ['no matched rows', { images: 0 }, /matched no training rows/],
    ];
    for (const [name, extra, err] of cases) {
      it(name, async () => {
        const { db, sql } = await freshDb();
        await expect(
          buildCoocSnapshot({ ...production(), query: imageDb(extra).query, sql })
        ).rejects.toThrow(err);
        const st = await db.query<{ status: string }>(
          `SELECT "status" FROM "ResourceIntentCoocSnapshot"`
        );
        expect(st.rows).toEqual([{ status: 'failed' }]);
      });
    }
  });

  describe('refused before any query or row', () => {
    const never = vi.fn(async () => {
      throw new Error('queried');
    });
    const cases: [string, Parameters<typeof buildCoocSnapshot>[0], RegExp][] = [
      [
        'production backdated with a trainEnd',
        production({ trainEnd: new Date(NOW.getTime() - 30 * DAY) }),
        /cannot be backdated/,
      ],
      [
        'trainEnd 1 ms later than now minus one day',
        {
          ...production(),
          kind: 'study',
          trainEnd: new Date(NOW.getTime() - DAY + 1),
          pinnedUntil: new Date(NOW.getTime() + DAY),
        },
        /at least 1 day/,
      ],
    ];
    for (const [name, opts, err] of cases) {
      it(name, async () => {
        const { db, sql } = await freshDb();
        await expect(buildCoocSnapshot({ ...opts, query: never, sql })).rejects.toThrow(err);
        expect(never).not.toHaveBeenCalled();
        expect((await db.query(`SELECT 1 FROM "ResourceIntentCoocSnapshot"`)).rows).toEqual([]);
      });
    }
  });

  it('a study at exactly now minus one day, pinned exactly 58 days, is accepted', async () => {
    const { db, sql } = await freshDb();
    // The real clock, not NOW: the row's pin CHECK is measured from `builtAt`, which the guard
    // trigger stamps from the database clock at insert. Read before the insert, so builtAt >= now
    // and a pin of exactly now + 58 days satisfies both the app check (measured from `now`) and
    // the CHECK (pinnedUntil > builtAt AND pinnedUntil <= builtAt + 58 days).
    const now = new Date();
    const trainEnd = new Date(now.getTime() - DAY);
    const pinnedUntil = new Date(now.getTime() + 58 * DAY);
    const s = await buildCoocSnapshot({
      kind: 'study',
      trainEnd,
      seed: SEED,
      pinnedUntil,
      dryRun: false,
      now,
      query: imageDb({}, trainEnd).query,
      sql,
    });
    expect([s.kind, s.created, s.trainEnd]).toEqual(['study', true, trainEnd.toISOString()]);
    const [row] = (
      await db.query<{ status: string; pinnedUntil: Date }>(
        `SELECT "status", "pinnedUntil" FROM "ResourceIntentCoocSnapshot"`
      )
    ).rows;
    expect(row.status).toBe('ready');
    expect(row.pinnedUntil.getTime()).toBe(pinnedUntil.getTime());
  });

  it('a model seen with two types keeps the first one drawn, and the build reports the conflicts', async () => {
    const { sql } = await freshDb();
    const images = imageDb({ typeConflict: true });
    const s = await buildCoocSnapshot({ ...production(), query: images.query, sql });
    expect(s.created).toBe(true);
    // Model 1000 is on every id % 4 === 0 image; only image 8 attaches it as a TextualInversion.
    const order = images.returned.filter((id) => id % 4 === 0);
    const typeOf = (id: number) => (id === 8 ? 'TextualInversion' : 'LORA');
    const first = typeOf(order[0]);
    expect(order.length).toBe(225);
    expect(s.typeConflicts).toBe(order.filter((id) => typeOf(id) !== first).length);
    expect(s.typeConflicts).toBeGreaterThan(0);
    const c = (await loadCoocSnapshot(sql, s.contentHash, { kind: 'production', now: NOW })).counts;
    const m = c.modelIds.indexOf(1000);
    expect(c.modelTypes[m]).toBe(first);
    // Both types are add-on types, so every one of its images still counts toward n_m.
    expect(c.nM[m]).toBe(225);
  });

  it('a build with the default query sends every draw statement through the timed transaction', async () => {
    const { sql } = await freshDb();
    const images = imageDb();
    const perTx: string[][] = [];
    dbMock.dbRead.$queryRaw.mockImplementation((() => {
      throw new Error('untimed replica read');
    }) as never);
    dbMock.dbRead.$transaction.mockImplementation((async (
      fn: (tx: unknown) => Promise<unknown>
    ) => {
      const log: string[] = [];
      perTx.push(log);
      return fn({
        $executeRawUnsafe: async (q: string) => {
          log.push(q);
          return 0;
        },
        $queryRaw: async (q: Prisma.Sql) => {
          log.push('query');
          return images.query(q);
        },
      });
    }) as never);
    try {
      const s = await buildCoocSnapshot({ ...production({ dryRun: true }), sql });
      expect(s.trainRows).toBe(900);
      expect(perTx.length).toBe(images.queries.length);
      expect(perTx.length).toBeGreaterThan(10);
      for (const log of perTx)
        expect(log).toEqual([
          `SET LOCAL statement_timeout = ${COOC_STATEMENT_TIMEOUT_MS}`,
          'query',
        ]);
    } finally {
      dbMock.dbRead.$transaction.mockReset();
      dbMock.dbRead.$queryRaw.mockReset();
    }
  });
});
