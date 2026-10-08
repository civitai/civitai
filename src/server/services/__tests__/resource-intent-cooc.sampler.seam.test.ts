import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  COOC_ELIGIBLE_REST,
  drawTrainingRows,
  fetchVersionText,
  mulberry32,
  type CoocDrawRow,
} from '~/server/services/resource-intent-cooc/build';

/**
 * Seam: the shipped sampler against the offline screen's `mulberry32` and draw loop, copied
 * verbatim below (reformatted by prettier only; the `dbRead` call is replaced by the same fake the
 * shipped code queries). Both run against one synthetic Image table.
 */
// ---------------------------------- ORACLE (screen source) ----------------------------------
function screenMulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
async function screenDraw(
  idLo: number,
  idHi: number,
  seed: number,
  target: number,
  idBatch: number,
  maxBatches: number,
  matchBatch: (ids: number[]) => number
) {
  const rand = screenMulberry32(seed);
  const tried = new Set<number>();
  const drawn: number[] = [];
  const batches: number[][] = [];
  const span = idHi - idLo + 1;
  for (let b = 0; b < maxBatches && drawn.length < target; b++) {
    const ids: number[] = [];
    while (ids.length < idBatch && tried.size < span) {
      const id = idLo + Math.floor(rand() * span);
      if (tried.has(id)) continue;
      tried.add(id);
      ids.push(id);
    }
    if (!ids.length) break;
    batches.push(ids);
    for (let i = 0; i < matchBatch(ids); i++) drawn.push(0);
  }
  return { batches, idsTried: tried.size, drawn: drawn.length };
}
// -------------------------------------- END ORACLE --------------------------------------------

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
/** Synthetic Image table: ids 1..maxId, one per hour, every third id ineligible. */
function fakeTable(maxId: number) {
  const createdAt = (id: number) => new Date(T0 + id * HOUR);
  const eligible = (id: number) => id % 3 !== 0;
  const batchIds: number[][] = [];
  const sqlTexts: string[] = [];
  const query = async (sql: Prisma.Sql): Promise<unknown[]> => {
    const text = sql.sql;
    sqlTexts.push(text);
    if (text.includes('max(id)')) return [{ max: maxId }];
    if (text.includes('ORDER BY id LIMIT 1')) {
      const mid = sql.values[0] as number;
      return mid <= maxId ? [{ id: mid, createdAt: createdAt(mid) }] : [];
    }
    if (text.includes('WITH s AS')) {
      const [ids, start, end] = sql.values as [number[], Date, Date];
      batchIds.push(ids);
      return ids
        .filter((id) => eligible(id) && createdAt(id) >= start && createdAt(id) < end)
        .map(
          (id): CoocDrawRow => ({
            imageId: id,
            createdAt: createdAt(id),
            prompt: 'p',
            att: [{ modelId: 1, modelType: 'LORA', versionId: 1 }],
          })
        );
    }
    throw new Error(`unexpected query: ${text.slice(0, 60)}`);
  };
  return { query, batchIds, sqlTexts, createdAt, eligible };
}

describe('cooc sampler seam: shipped == screen', () => {
  it('mulberry32 is the screen generator, value for value', () => {
    for (const seed of [0, 1, 20261008, 2 ** 31 - 1, 0xdeadbeef]) {
      const a = mulberry32(seed);
      const b = screenMulberry32(seed);
      for (let i = 0; i < 2000; i++) expect(a()).toBe(b());
    }
  });

  for (const c of [
    { name: 'stops at the target', target: 300, idBatch: 200, maxBatches: 50 },
    { name: 'stops at maxBatches', target: 1e9, idBatch: 150, maxBatches: 4 },
    { name: 'exhausts the id range', target: 1e9, idBatch: 400, maxBatches: 50 },
  ]) {
    it(`draws the same id batches as the screen loop (${c.name})`, async () => {
      const t = fakeTable(5000);
      const trainStart = new Date(T0 + 1000 * HOUR + 1);
      const trainEnd = new Date(T0 + 3000 * HOUR);
      let matched = 0;
      const stats = await drawTrainingRows({
        query: t.query,
        trainStart,
        trainEnd,
        seed: 20261008,
        target: c.target,
        idBatch: c.idBatch,
        maxBatches: c.maxBatches,
        onBatch: async (rows) => {
          matched += rows.length;
        },
      });
      // Bounds: the first id at or after each bound, by binary search.
      expect([stats.idLo, stats.idHi]).toEqual([1001, 2999]);
      const want = await screenDraw(
        stats.idLo,
        stats.idHi,
        20261008,
        c.target,
        c.idBatch,
        c.maxBatches,
        (ids) => ids.filter((id) => t.eligible(id)).length
      );
      expect(t.batchIds).toEqual(want.batches);
      expect(stats.idsTried).toBe(want.idsTried);
      expect(stats.matched).toBe(want.drawn);
      expect(matched).toBe(want.drawn);
      expect(stats.batches).toBe(want.batches.length);
      expect(new Set(t.batchIds.flat()).size).toBe(t.batchIds.flat().length);
    });
  }

  it('the batch statement embeds the eligibility fragment and the window bounds', async () => {
    const t = fakeTable(500);
    await drawTrainingRows({
      query: t.query,
      trainStart: new Date(T0 + 100 * HOUR),
      trainEnd: new Date(T0 + 300 * HOUR),
      seed: 1,
      target: 10,
      idBatch: 20,
      maxBatches: 1,
      onBatch: async () => undefined,
    });
    const batch = t.sqlTexts.find((s) => s.includes('WITH s AS')) as string;
    expect(batch).toContain(COOC_ELIGIBLE_REST);
    expect(batch).toContain('i."createdAt" >= ? AND i."createdAt" < ?');
    expect(batch).toContain(
      'AND EXISTS (SELECT 1 FROM "ImageResourceNew" r WHERE r."imageId" = i.id)'
    );
  });

  it('the draw absorbs up to two failures of a statement, not three', async () => {
    const flaky = (failures: number) => {
      const t = fakeTable(500);
      let n = 0;
      return async (sql: Prisma.Sql) => {
        if (sql.sql.includes('WITH s AS') && n++ < failures) throw new Error('replica blip');
        return t.query(sql);
      };
    };
    const draw = (failures: number) =>
      drawTrainingRows({
        query: flaky(failures),
        trainStart: new Date(T0 + 100 * HOUR),
        trainEnd: new Date(T0 + 300 * HOUR),
        seed: 1,
        target: 10,
        idBatch: 20,
        maxBatches: 1,
        onBatch: async () => undefined,
        retryDelayMs: 0,
      });
    await expect(draw(2)).resolves.toMatchObject({ batches: 1 });
    await expect(draw(3)).rejects.toThrow('replica blip');
  });

  it('the version-text lookup absorbs up to two failures, not three', async () => {
    const flaky = (failures: number) => {
      let n = 0;
      return async (sql: Prisma.Sql) => {
        if (n++ < failures) throw new Error('replica blip');
        return (sql.values[0] as number[]).map((id) => ({
          id,
          trainedWords: null,
          modelName: 'm',
        }));
      };
    };
    expect((await fetchVersionText(flaky(2), [1, 2], 0)).size).toBe(2);
    await expect(fetchVersionText(flaky(3), [1, 2], 0)).rejects.toThrow('replica blip');
  });
});
