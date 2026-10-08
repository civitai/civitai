import { describe, expect, it, vi } from 'vitest';
import {
  buildCoocSnapshot,
  defaultCoocTrainEnd,
} from '~/server/services/resource-intent-cooc/pipeline';
import { RESOURCE_INTENT_COOC_SPEC } from '~/server/services/resource-intent-cooc/spec';
import { loadCoocSnapshot } from '~/server/services/resource-intent-cooc/store';
import { fakeImageDb, freshDb } from './resource-intent-cooc.harness';

vi.setConfig({ testTimeout: 60_000 });

const DAY = 86_400_000;
const NOW = new Date();
const SEED = RESOURCE_INTENT_COOC_SPEC.defaultSeed;

function imageDb() {
  const trainEnd = defaultCoocTrainEnd(NOW);
  return fakeImageDb({
    trainStart: new Date(trainEnd.getTime() - RESOURCE_INTENT_COOC_SPEC.trainDays * DAY),
    trainEnd,
    images: 900,
  });
}

describe('cooc build pipeline', () => {
  it('a production build trains up to UTC midnight minus one day and lands one ready row', async () => {
    const { db, sql } = await freshDb();
    const images = imageDb();
    const s = await buildCoocSnapshot({
      kind: 'production',
      seed: SEED,
      pinnedUntil: null,
      dryRun: false,
      now: NOW,
      query: images.query,
      sql,
    });
    expect(s.trainEnd).toBe(defaultCoocTrainEnd(NOW).toISOString());
    expect(new Date(s.trainEnd).getTime()).toBeLessThanOrEqual(NOW.getTime() - DAY);
    expect(s.trainRows).toBe(900);
    expect(s.created).toBe(true);
    const rows = await db.query<{
      status: string;
      kind: string;
      contentHash: string;
      trainRows: number;
    }>(`SELECT "status","kind","contentHash","trainRows" FROM "ResourceIntentCoocSnapshot"`);
    expect(rows.rows).toEqual([
      { status: 'ready', kind: 'production', contentHash: s.contentHash, trainRows: 900 },
    ]);
    const loaded = await loadCoocSnapshot(sql, s.contentHash, { kind: 'production', now: NOW });
    expect(loaded.counts.N).toBe(900);
    // Own-model tokens are removed in training: every model is named "Model <n>", so "model" never
    // indexes; "rare0" (version 2000's trigger) appears only on images attaching model 1000, so it is
    // removed everywhere, while "rare4", on the same images, is kept and pairs with model 1000.
    const c = loaded.counts;
    expect(c.vocab).not.toContain('model');
    expect(c.vocab).not.toContain('rare0');
    const t = c.vocab.indexOf('rare4');
    const m = c.modelIds.indexOf(1000);
    expect(t).toBeGreaterThanOrEqual(0);
    expect([...c.modelIdx.subarray(c.ptr[t], c.ptr[t + 1])]).toContain(m);
    // Aggregates only: no token reaches the summary.
    expect(JSON.stringify(s)).not.toMatch(/tok0|shared|rare/);
  });

  it('a dry run builds the same content and writes nothing', async () => {
    const { db, sql } = await freshDb();
    const dry = await buildCoocSnapshot({
      kind: 'production',
      seed: SEED,
      pinnedUntil: null,
      dryRun: true,
      now: NOW,
      query: imageDb().query,
      sql,
    });
    expect(dry.rowId).toBeNull();
    expect((await db.query(`SELECT 1 FROM "ResourceIntentCoocSnapshot"`)).rows).toEqual([]);
    const real = await buildCoocSnapshot({
      kind: 'production',
      seed: SEED,
      pinnedUntil: null,
      dryRun: false,
      now: NOW,
      query: imageDb().query,
      sql,
    });
    expect(real.contentHash).toBe(dry.contentHash);
  });

  it('a build that throws mid-draw leaves a failed row, not a ready one', async () => {
    const { db, sql } = await freshDb();
    const images = imageDb();
    let n = 0;
    const query = async (s: Parameters<typeof images.query>[0]) => {
      if (s.sql.includes('WITH s AS') && ++n === 1)
        throw Object.assign(new Error('boom'), { permanent: true });
      return images.query(s);
    };
    await expect(
      buildCoocSnapshot({
        kind: 'production',
        seed: SEED,
        pinnedUntil: null,
        dryRun: false,
        now: NOW,
        query,
        sql,
      })
    ).resolves.toBeDefined(); // the screen's retry absorbs one failure
    const failing = async (s: Parameters<typeof images.query>[0]) => {
      if (s.sql.includes('WITH s AS')) throw new Error('boom');
      return images.query(s);
    };
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    try {
      await expect(
        buildCoocSnapshot({
          kind: 'production',
          seed: SEED + 1,
          pinnedUntil: null,
          dryRun: false,
          now: NOW,
          query: failing,
          sql,
        })
      ).rejects.toThrow('boom');
    } finally {
      vi.useRealTimers();
    }
    const st = await db.query<{ status: string }>(
      `SELECT "status" FROM "ResourceIntentCoocSnapshot" ORDER BY "status"`
    );
    expect(st.rows.map((r) => r.status)).toEqual(['failed', 'ready']);
  }, 120_000);

  describe('refused before any query or row', () => {
    const never = vi.fn(async () => {
      throw new Error('queried');
    });
    const cases: [string, Parameters<typeof buildCoocSnapshot>[0], RegExp][] = [
      [
        'production backdated with a trainEnd',
        {
          kind: 'production',
          trainEnd: new Date(NOW.getTime() - 30 * DAY),
          seed: SEED,
          pinnedUntil: null,
          dryRun: false,
        },
        /cannot be backdated/,
      ],
      [
        'production with a pin',
        {
          kind: 'production',
          seed: SEED,
          pinnedUntil: new Date(NOW.getTime() + DAY),
          dryRun: false,
        },
        /cannot be pinned/,
      ],
      [
        'study without a pin',
        { kind: 'study', seed: SEED, pinnedUntil: null, dryRun: false },
        /requires a pin/,
      ],
      [
        'study pinned 60 days',
        {
          kind: 'study',
          seed: SEED,
          pinnedUntil: new Date(NOW.getTime() + 60 * DAY),
          dryRun: false,
        },
        /58 days/,
      ],
      [
        'study pinned 58 days + 1 ms',
        {
          kind: 'study',
          seed: SEED,
          pinnedUntil: new Date(NOW.getTime() + 58 * DAY + 1),
          dryRun: false,
        },
        /58 days/,
      ],
      [
        'trainEnd later than now minus one day',
        {
          kind: 'study',
          trainEnd: new Date(NOW.getTime() - DAY + 1000),
          seed: SEED,
          pinnedUntil: new Date(NOW.getTime() + DAY),
          dryRun: false,
        },
        /at least 1 day/,
      ],
      [
        'a seed beyond int32',
        { kind: 'production', seed: 2 ** 31, pinnedUntil: null, dryRun: false },
        /seed/,
      ],
    ];
    for (const [name, opts, err] of cases) {
      it(name, async () => {
        const { db, sql } = await freshDb();
        await expect(buildCoocSnapshot({ ...opts, now: NOW, query: never, sql })).rejects.toThrow(
          err
        );
        expect(never).not.toHaveBeenCalled();
        expect((await db.query(`SELECT 1 FROM "ResourceIntentCoocSnapshot"`)).rows).toEqual([]);
      });
    }
  });

  it('a study build at exactly now minus one day, pinned 58 days, is accepted', async () => {
    const { sql } = await freshDb();
    const trainEnd = new Date(Math.floor((NOW.getTime() - DAY) / 1000) * 1000);
    const images = fakeImageDb({
      trainStart: new Date(trainEnd.getTime() - 120 * DAY),
      trainEnd,
      images: 300,
    });
    const s = await buildCoocSnapshot({
      kind: 'study',
      trainEnd,
      seed: SEED,
      pinnedUntil: new Date(Date.now() + 58 * DAY - 60_000),
      dryRun: false,
      now: NOW,
      query: images.query,
      sql,
    });
    expect(s.kind).toBe('study');
    expect(s.created).toBe(true);
  });
});
