import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import type * as RedisCaches from '~/server/redis/caches';
import type * as ImageService from '~/server/services/image.service';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

const mocks = vi.hoisted(() => ({
  queueImageSearchIndexUpdate: vi.fn(),
  bust: vi.fn(),
  bustCacheTag: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate: mocks.queueImageSearchIndexUpdate,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  imageResourcesCache: { bust: mocks.bust },
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  bustCacheTag: mocks.bustCacheTag,
}));

import handler from '~/pages/api/admin/temp/sweep-image-resources';

type Call = { text: string; values: unknown[] };

/** A $queryRaw call as SQL text, with Prisma.raw fragments inlined and parameters as `?`. */
function toCall(strings: TemplateStringsArray, ...values: unknown[]): Call {
  const params: unknown[] = [];
  let text = strings[0];
  values.forEach((v, i) => {
    const raw = v as { strings?: string[]; values?: unknown[] };
    if (raw && Array.isArray(raw.strings) && Array.isArray(raw.values) && !raw.values.length)
      text += raw.strings.join('');
    else {
      params.push(v);
      text += '?';
    }
    text += strings[i + 1];
  });
  return { text: text.replace(/\s+/g, ' ').trim(), values: params };
}

function route(client: 'dbRead' | 'dbWrite', answer: (c: Call) => unknown) {
  const calls: Call[] = [];
  dbMock[client].$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const c = toCall(strings, ...values);
    calls.push(c);
    // Every loop in the endpoint must end on its own; a fake that answers forever would turn a
    // broken exit into a microtask spin the test timeout cannot interrupt.
    if (calls.length > 50) throw new Error(`runaway ${client} loop: ${c.text.slice(0, 60)}`);
    return answer(c);
  }) as never);
  return calls;
}

async function call(query: Record<string, string>) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    { query: { sleepMs: '0', ...query } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res.json.mock.calls[0]?.[0];
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  dbMock.dbRead.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw.mockReset();
});

// The whole statement, not fragments: which rows this endpoint deletes IS its SQL text, so any edit
// to it must show up here and be read.
const SQL = {
  next: 'SELECT min("modelVersionId") AS next FROM "ImageResourceNew" WHERE "modelVersionId" >= ?',
  missing:
    'WITH RECURSIVE ids AS ( (SELECT "modelVersionId" AS v FROM "ImageResourceNew" WHERE "modelVersionId" >= ? ORDER BY 1 LIMIT 1) UNION ALL SELECT (SELECT "modelVersionId" FROM "ImageResourceNew" WHERE "modelVersionId" > ids.v ORDER BY 1 LIMIT 1) FROM ids WHERE ids.v < ? ) SELECT v FROM ids WHERE v IS NOT NULL AND v < ? AND NOT EXISTS (SELECT 1 FROM "ModelVersion" mv WHERE mv.id = ids.v)',
  count: 'SELECT count(*)::int AS n FROM "ImageResourceNew" WHERE "modelVersionId" = ANY(?::int[])',
  deleteDangling:
    'WITH t AS ( SELECT irn."imageId", irn."modelVersionId" FROM "ImageResourceNew" irn WHERE irn."modelVersionId" = ANY(?::int[]) AND NOT EXISTS (SELECT 1 FROM "ModelVersion" mv WHERE mv.id = irn."modelVersionId") LIMIT ? ), d AS ( DELETE FROM "ImageResourceNew" irn USING t WHERE irn."imageId" = t."imageId" AND irn."modelVersionId" = t."modelVersionId" RETURNING irn.* ) INSERT INTO "_sweep_irn_20260925" ("imageId", "modelVersionId", "strength", "detected", "tier") SELECT "imageId", "modelVersionId", "strength", "detected", \'dangling\' FROM d RETURNING "imageId", "modelVersionId"',
  select:
    'SELECT irn."imageId", irn."modelVersionId", CASE WHEN mv.status = \'Draft\' THEN \'draft\' ELSE \'private\' END AS tier FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId" JOIN "ImageResourceNew" irn ON irn."modelVersionId" = mv.id JOIN "Image" i ON i.id = irn."imageId" LEFT JOIN "User" u ON u.id = i."userId" LEFT JOIN "Post" ps ON ps.id = i."postId" WHERE mv.id >= ? AND mv.id < ? AND ( (mv.status = \'Draft\' AND mv."publishedAt" IS NULL AND NOT EXISTS ( SELECT 1 FROM "Post" pp WHERE pp."modelVersionId" = mv.id AND pp."publishedAt" IS NOT NULL)) OR (mv.status = \'Published\' AND m.status = \'Published\' AND (mv.availability = \'Private\' OR m.availability = \'Private\')) ) AND ( i."userId" <> m."userId" AND NOT coalesce(u."isModerator", false) AND ( (NOT irn.detected AND ps."modelVersionId" IS DISTINCT FROM irn."modelVersionId") OR (irn.detected AND jsonb_typeof(i.meta->\'civitaiResources\') = \'array\' AND i.meta->\'civitaiResources\' @> jsonb_build_array( jsonb_build_object(\'modelVersionId\', irn."modelVersionId"))) ) AND NOT ((CASE WHEN mv.status = \'Draft\' THEN \'draft\' ELSE \'private\' END) = \'private\' AND EXISTS ( SELECT 1 FROM "EntityAccess" ea WHERE ea."accessToId" = mv.id AND ea."accessToType" = \'ModelVersion\' AND ea."accessorType" = \'User\' AND ea."accessorId" = i."userId")) )',
  deleteNonVisible:
    'WITH p AS ( SELECT * FROM unnest( ?::int[], ?::int[] ) AS p("imageId", "modelVersionId") ), d AS ( DELETE FROM "ImageResourceNew" irn USING p, "ModelVersion" mv, "Model" m, "Image" i LEFT JOIN "User" u ON u.id = i."userId" LEFT JOIN "Post" ps ON ps.id = i."postId" WHERE irn."imageId" = p."imageId" AND irn."modelVersionId" = p."modelVersionId" AND mv.id = irn."modelVersionId" AND m.id = mv."modelId" AND i.id = irn."imageId" AND ( (mv.status = \'Draft\' AND mv."publishedAt" IS NULL AND NOT EXISTS ( SELECT 1 FROM "Post" pp WHERE pp."modelVersionId" = mv.id AND pp."publishedAt" IS NOT NULL)) OR (mv.status = \'Published\' AND m.status = \'Published\' AND (mv.availability = \'Private\' OR m.availability = \'Private\')) ) AND ( i."userId" <> m."userId" AND NOT coalesce(u."isModerator", false) AND ( (NOT irn.detected AND ps."modelVersionId" IS DISTINCT FROM irn."modelVersionId") OR (irn.detected AND jsonb_typeof(i.meta->\'civitaiResources\') = \'array\' AND i.meta->\'civitaiResources\' @> jsonb_build_array( jsonb_build_object(\'modelVersionId\', irn."modelVersionId"))) ) AND NOT ((CASE WHEN mv.status = \'Draft\' THEN \'draft\' ELSE \'private\' END) = \'private\' AND EXISTS ( SELECT 1 FROM "EntityAccess" ea WHERE ea."accessToId" = mv.id AND ea."accessToType" = \'ModelVersion\' AND ea."accessorType" = \'User\' AND ea."accessorId" = i."userId")) ) RETURNING irn.*, CASE WHEN mv.status = \'Draft\' THEN \'draft\' ELSE \'private\' END AS tier ) INSERT INTO "_sweep_irn_20260925" ("imageId", "modelVersionId", "strength", "detected", "tier") SELECT "imageId", "modelVersionId", "strength", "detected", tier FROM d RETURNING "imageId", "modelVersionId", "tier"',
  captured:
    'SELECT DISTINCT "imageId", "modelVersionId" FROM "_sweep_irn_20260925" WHERE "sweptAt" >= ? AND "sweptAt" < ? AND ("imageId", "modelVersionId") >= (?, ?) ORDER BY "imageId", "modelVersionId" LIMIT ?',
};

const DAY = 24 * 60 * 60 * 1000;

describe('sweep-image-resources: dangling', () => {
  function arrangeRead({ ids = [5, 7], next = null as number | null } = {}) {
    return route('dbRead', ({ text }) => {
      if (text.includes('max("modelVersionId")')) return [{ max: 99 }];
      if (text.startsWith('WITH RECURSIVE')) return ids.map((v) => ({ v }));
      if (text.startsWith('SELECT count(*)')) return [{ n: 3 }];
      if (text.includes('min("modelVersionId")')) return [{ next }];
      throw new Error(`unexpected read: ${text}`);
    });
  }

  it('is a dry run by default: counts, never writes, touches no search or cache', async () => {
    const reads = arrangeRead();
    const out = await call({ tier: 'dangling' });

    expect(out).toMatchObject({ dryRun: true, rows: 3, byTier: { dangling: 3 }, nextStart: null });
    expect(reads.find((r) => r.text.startsWith('WITH RECURSIVE'))!.text).toBe(SQL.missing);
    expect(reads.find((r) => r.text.startsWith('SELECT count(*)'))!.text).toBe(SQL.count);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.queueImageSearchIndexUpdate).not.toHaveBeenCalled();
    expect(mocks.bust).not.toHaveBeenCalled();
    expect(mocks.bustCacheTag).not.toHaveBeenCalled();
  });

  // Keep the capture in the DELETE's own statement: split into two, a failure between them loses
  // rows the rollback depends on.
  it('deletes and captures in one statement that re-checks the version on the primary', async () => {
    arrangeRead();
    const writes = route('dbWrite', () => [
      { imageId: 1, modelVersionId: 5 },
      { imageId: 2, modelVersionId: 7 },
    ]);

    const out = await call({ tier: 'dangling', dryRun: 'false' });

    expect(writes).toHaveLength(1);
    expect(writes[0].text).toBe(SQL.deleteDangling);
    expect(writes[0].values).toEqual([[5, 7], 10000]);
    expect(out).toMatchObject({ dryRun: false, rows: 2, images: 2, sideEffectFailures: 0 });
    expect(mocks.queueImageSearchIndexUpdate).toHaveBeenCalledWith({
      ids: [1, 2],
      action: SearchIndexUpdateQueueAction.Update,
    });
    expect(mocks.bust).toHaveBeenCalledWith([1, 2]);
    expect(mocks.bustCacheTag).toHaveBeenCalledWith([
      'images-modelVersion:5',
      'images-modelVersion:7',
    ]);
  });

  it('repeats a capped statement until it comes back short, one side-effect pass each', async () => {
    arrangeRead({ ids: [5] });
    let n = 0;
    // Throws past a few calls, so a loop that ignores a short batch fails fast instead of spinning
    // until the budget.
    const writes = route('dbWrite', () => {
      if (++n > 5) throw new Error(`runaway delete loop: call ${n}`);
      return n === 1
        ? [
            { imageId: 1, modelVersionId: 5 },
            { imageId: 2, modelVersionId: 5 },
          ]
        : n === 2
        ? [{ imageId: 3, modelVersionId: 5 }]
        : [];
    });

    const out = await call({ tier: 'dangling', dryRun: 'false', rowCap: '2' });

    expect(writes.map((w) => w.values)).toEqual([
      [[5], 2],
      [[5], 2],
    ]);
    expect(mocks.queueImageSearchIndexUpdate).toHaveBeenCalledTimes(2);
    expect(out.rows).toBe(3);
  });

  it('splits the missing ids into batches of 500', async () => {
    arrangeRead({ ids: Array.from({ length: 501 }, (_, i) => i + 1) });
    const writes = route('dbWrite', () => []);

    await call({ tier: 'dangling', dryRun: 'false' });

    expect(writes.map((w) => (w.values[0] as number[]).length)).toEqual([500, 1]);
  });

  it('skips ahead to the next credited version id between chunks', async () => {
    let next: number | null = 400;
    const reads = route('dbRead', ({ text }) => {
      if (text.includes('max("modelVersionId")')) return [{ max: 499 }];
      if (text.startsWith('WITH RECURSIVE')) return [];
      if (text.includes('min("modelVersionId")')) {
        const found = next;
        next = null;
        return [{ next: found }];
      }
      throw new Error(`unexpected read: ${text}`);
    });

    await call({ tier: 'dangling', chunk: '100' });

    expect(reads.find((r) => r.text.includes('min("modelVersionId")'))!.text).toBe(SQL.next);

    const chunks = reads.filter((r) => r.text.startsWith('WITH RECURSIVE')).map((r) => r.values);
    expect(chunks).toEqual([
      [0, 100, 100],
      [400, 500, 500],
    ]);
  });

  it('records a failed search or cache update and carries on, since the rows are already gone', async () => {
    arrangeRead({ ids: [5] });
    route('dbWrite', () => [{ imageId: 9, modelVersionId: 5 }]);
    mocks.bust.mockRejectedValueOnce(new Error('redis down'));

    const out = await call({ tier: 'dangling', dryRun: 'false' });

    expect(out).toMatchObject({ rows: 1, sideEffectFailures: 1, failedImageIds: [9] });
  });
});

describe('sweep-image-resources: visibility', () => {
  const PAIRS = [
    { imageId: 1, modelVersionId: 10, tier: 'draft' },
    { imageId: 2, modelVersionId: 10, tier: 'draft' },
    { imageId: 3, modelVersionId: 11, tier: 'private' },
  ];

  const answerReads = ({ text }: Call) => {
    if (text.includes('max(id)')) return [{ max: 19 }];
    if (text.startsWith('SELECT irn."imageId"')) return PAIRS;
    throw new Error(`unexpected read: ${text}`);
  };
  const selects = (calls: Call[]) =>
    calls.filter((r) => r.text.startsWith('SELECT irn."imageId"')).map((r) => r.values);

  it('dry run selects on the replica with the exact rule, counts by tier, and writes nothing', async () => {
    const reads = route('dbRead', answerReads);

    const out = await call({ tier: 'visibility', chunk: '100' });

    expect(reads.find((r) => r.text.startsWith('SELECT irn."imageId"'))!.text).toBe(SQL.select);
    expect(out).toMatchObject({ rows: 3, byTier: { draft: 2, private: 1 }, images: 3 });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.queueImageSearchIndexUpdate).not.toHaveBeenCalled();
    expect(mocks.bust).not.toHaveBeenCalled();
    expect(mocks.bustCacheTag).not.toHaveBeenCalled();
  });

  // The primary applies the whole rule again, so a row whose version or owner changed since the
  // replica read is kept, and the pair join spares every other resource on the image.
  it('deletes by exact pair on the primary, re-applying the rule, in slices of rowCap', async () => {
    route('dbRead', answerReads);
    const writes = route('dbWrite', (c) =>
      (c.values[0] as number[]).includes(1)
        ? [{ imageId: 1, modelVersionId: 10, tier: 'draft' }]
        : [{ imageId: 3, modelVersionId: 11, tier: 'private' }]
    );

    const out = await call({ tier: 'visibility', dryRun: 'false', chunk: '100', rowCap: '2' });

    expect(writes).toHaveLength(2);
    expect(writes[0].text).toBe(SQL.deleteNonVisible);
    expect(writes.map((w) => w.values)).toEqual([
      [
        [1, 2],
        [10, 10],
      ],
      [[3], [11]],
    ]);
    expect(out).toMatchObject({ rows: 2, byTier: { draft: 1, private: 1 }, images: 2 });
  });

  it('walks version chunks and reports no cursor once done', async () => {
    const reads = route('dbRead', answerReads);

    const out = await call({ tier: 'visibility', chunk: '5' });

    expect(selects(reads)).toEqual([
      [0, 5],
      [5, 10],
      [10, 15],
      [15, 20],
    ]);
    expect(out.nextStart).toBeNull();
  });

  it('stops at the budget with a cursor, and resumes from it', async () => {
    let now = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const reads = route('dbRead', (c) => {
      const answer = answerReads(c);
      if (c.text.startsWith('SELECT irn."imageId"')) now += 2 * DAY;
      return answer;
    });

    const first = await call({ tier: 'visibility', chunk: '5' });
    expect(first.nextStart).toBe(5);

    now = 0;
    await call({ tier: 'visibility', chunk: '5', start: String(first.nextStart) });
    expect(selects(reads)).toEqual([
      [0, 5],
      [5, 10],
    ]);
    spy.mockRestore();
  });

  // Resuming from the chunk's own start is what makes an interrupted chunk safe: its remaining
  // rows are selected again, and the ones already deleted are not.
  it('stops inside a chunk at the budget and hands back that chunk’s start', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    route('dbRead', answerReads);
    const writes = route('dbWrite', (c) => {
      now += 2 * DAY;
      return [{ imageId: (c.values[0] as number[])[0], modelVersionId: 10, tier: 'draft' }];
    });

    const out = await call({ tier: 'visibility', dryRun: 'false', chunk: '100', rowCap: '1' });

    expect(writes).toHaveLength(1);
    expect(out).toMatchObject({ rows: 1, nextStart: 0 });
  });
});

describe('sweep-image-resources: redrive', () => {
  it('dry run counts captured rows and replays nothing', async () => {
    let batch = 0;
    route('dbRead', () => (++batch === 1 ? [{ imageId: 1, modelVersionId: 5 }] : []));

    const out = await call({
      tier: 'redrive',
      since: '2026-09-25T00:00:00Z',
      until: '2026-09-26T00:00:00Z',
    });

    expect(out).toMatchObject({ dryRun: true, rows: 1, nextStart: null });
    expect(mocks.queueImageSearchIndexUpdate).not.toHaveBeenCalled();
    expect(mocks.bust).not.toHaveBeenCalled();
  });

  it('needs a capture window', async () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      { query: { tier: 'redrive', dryRun: 'false' } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('replays search and cache updates for captured rows, resuming after the last pair', async () => {
    let batch = 0;
    const reads = route('dbRead', () => {
      if (++batch > 5) throw new Error(`runaway redrive loop: call ${batch}`);
      return batch === 1
        ? [
            { imageId: 1, modelVersionId: 5 },
            { imageId: 4, modelVersionId: 5 },
          ]
        : batch === 2
        ? [{ imageId: 4, modelVersionId: 6 }]
        : [];
    });

    const out = await call({
      tier: 'redrive',
      dryRun: 'false',
      since: '2026-09-25T00:00:00Z',
      until: '2026-09-26T00:00:00Z',
      rowCap: '2',
    });

    expect(reads[0].text).toBe(SQL.captured);
    expect(reads[0].values).toEqual([
      new Date('2026-09-25T00:00:00Z'),
      new Date('2026-09-26T00:00:00Z'),
      0,
      0,
      2,
    ]);
    expect(reads.map((r) => [r.values[2], r.values[3]])).toEqual([
      [0, 0],
      [4, 6],
    ]);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.queueImageSearchIndexUpdate).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ rows: 3, nextStart: null });
  });
});
