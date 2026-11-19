import { describe, expect, it, vi } from 'vitest';
import { deserializeTrainImageIds } from '~/server/services/resource-intent-cooc/build';
import type { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { COOC_STATEMENT_TIMEOUT_MS } from '~/server/services/resource-intent-cooc/build';
import { buildCoocSnapshot } from '~/server/services/resource-intent-cooc/pipeline';
import { RESOURCE_INTENT_COOC_SPEC } from '~/server/services/resource-intent-cooc/spec';
import { loadCoocSnapshot } from '~/server/services/resource-intent-cooc/store';
import { fakeImageDb, freshDb } from './resource-intent-cooc.harness';

vi.setConfig({ testTimeout: 60_000 });

const DAY = 86_400_000;
// Fixed, and earlier than the wall clock the database stamps `builtAt` with, so a pin measured
// from it also satisfies the CHECK measured from `builtAt`.
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

  describe('a build that fails leaves a failed row, never a ready one', () => {
    const inWindow = (imageId: number, createdAt: Date) => ({
      imageId,
      createdAt,
      prompt: 'tok00001',
      att: [{ modelId: 1000, modelType: 'LORA', versionId: 2000 }],
    });
    it('a row at trainEnd', async () => {
      const { db, sql } = await freshDb();
      const extra = { injectFirstBatch: [inWindow(999_999, PROD_TRAIN_END)] };
      await expect(
        buildCoocSnapshot({ ...production(), query: imageDb(extra).query, sql })
      ).rejects.toThrow(/outside the training window/);
      const st = await db.query<{ status: string }>(
        `SELECT "status" FROM "ResourceIntentCoocSnapshot"`
      );
      expect(st.rows).toEqual([{ status: 'failed' }]);
    });
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
