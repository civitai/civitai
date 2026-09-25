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
  return { text: text.replace(/\s+/g, ' '), values: params };
}

function route(client: 'dbRead' | 'dbWrite', answer: (c: Call) => unknown) {
  const calls: Call[] = [];
  dbMock[client].$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const c = toCall(strings, ...values);
    calls.push(c);
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
  vi.clearAllMocks();
});

describe('sweep-image-resources: dangling', () => {
  function arrangeRead() {
    return route('dbRead', ({ text }) => {
      if (text.includes('max("modelVersionId")')) return [{ max: 99 }];
      if (text.includes('WITH RECURSIVE')) return [{ v: 5 }, { v: 7 }];
      if (text.includes('count(*)')) return [{ n: 3 }];
      if (text.includes('min("modelVersionId")')) return [{ next: null }];
      throw new Error(`unexpected read: ${text}`);
    });
  }

  it('is a dry run by default: counts and never writes', async () => {
    arrangeRead();
    const out = await call({ tier: 'dangling' });

    expect(out).toMatchObject({ dryRun: true, rows: 3, byTier: { dangling: 3 }, nextStart: null });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.queueImageSearchIndexUpdate).not.toHaveBeenCalled();
  });

  // Keep the capture in the DELETE's own statement: split into two, a failure between them loses
  // rows the rollback depends on.
  it('captures every deleted row in the same statement that deletes it', async () => {
    arrangeRead();
    const writes = route('dbWrite', () => [
      { imageId: 1, modelVersionId: 5 },
      { imageId: 2, modelVersionId: 7 },
      { imageId: 1, modelVersionId: 7 },
    ]);

    const out = await call({ tier: 'dangling', dryRun: 'false' });

    expect(writes).toHaveLength(1);
    const [{ text, values }] = writes;
    expect(text).toMatch(/^ ?WITH d AS \( DELETE FROM "ImageResourceNew" irn/);
    expect(text).toContain(
      'NOT EXISTS (SELECT 1 FROM "ModelVersion" mv WHERE mv.id = irn."modelVersionId")'
    );
    expect(text).toContain('INSERT INTO "_sweep_irn_20260925"');
    expect(text).toContain("'dangling' FROM d");
    expect(values).toEqual([[5, 7]]);
    expect(out).toMatchObject({ dryRun: false, rows: 3, images: 2 });
  });

  it('refreshes search, the resource cache and the version tags once per batch', async () => {
    arrangeRead();
    route('dbWrite', () => [
      { imageId: 1, modelVersionId: 5 },
      { imageId: 2, modelVersionId: 7 },
      { imageId: 1, modelVersionId: 7 },
    ]);

    await call({ tier: 'dangling', dryRun: 'false' });

    expect(mocks.queueImageSearchIndexUpdate).toHaveBeenCalledTimes(1);
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
});

describe('sweep-image-resources: visibility', () => {
  const PAIRS = [
    { imageId: 1, modelVersionId: 10, tier: 'never_published' },
    { imageId: 2, modelVersionId: 10, tier: 'never_published' },
    { imageId: 3, modelVersionId: 11, tier: 'private' },
  ];

  const answerPairs = ({ text }: Call) => {
    if (text.includes('max(id)')) return [{ max: 19 }];
    if (text.includes('WITH inv AS')) return PAIRS;
    throw new Error(`unexpected query: ${text}`);
  };

  it('dry run reads the replica and counts by tier', async () => {
    route('dbRead', answerPairs);

    const out = await call({ tier: 'visibility', chunk: '100' });

    expect(out).toMatchObject({
      dryRun: true,
      rows: 3,
      byTier: { never_published: 2, private: 1 },
      images: 3,
    });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('decides on the primary, deletes exactly the selected pairs, and counts only what was removed', async () => {
    route('dbRead', answerPairs);
    const writes = route('dbWrite', (c) => {
      if (c.text.includes('WITH inv AS')) return PAIRS;
      // One pair was already gone by the time of the delete.
      return [
        { imageId: 1, modelVersionId: 10 },
        { imageId: 3, modelVersionId: 11 },
      ];
    });

    const out = await call({ tier: 'visibility', dryRun: 'false', chunk: '100' });

    const del = writes.find((w) => w.text.includes('DELETE FROM'))!;
    expect(del.text).toContain('INSERT INTO "_sweep_irn_20260925"');
    expect(del.values).toEqual([
      [1, 2, 3],
      [10, 10, 11],
      ['never_published', 'never_published', 'private'],
    ]);
    expect(out).toMatchObject({ rows: 2, byTier: { never_published: 1, private: 1 }, images: 2 });
    expect(mocks.queueImageSearchIndexUpdate).toHaveBeenCalledWith({
      ids: [1, 3],
      action: SearchIndexUpdateQueueAction.Update,
    });
  });

  it('selects only client-supplied rows: manual ones and those listed in meta.civitaiResources', async () => {
    const reads = route('dbRead', answerPairs);

    await call({ tier: 'visibility', chunk: '100' });

    const select = reads.find((r) => r.text.includes('WITH inv AS'))!.text;
    expect(select).toContain(
      '(NOT irn.detected AND p."modelVersionId" IS DISTINCT FROM irn."modelVersionId")'
    );
    expect(select).toContain(`i.meta->'civitaiResources' @> jsonb_build_array(`);
    expect(select).toContain(
      'WHERE i."userId" <> inv.owner AND NOT coalesce(u."isModerator", false)'
    );
  });

  it('walks the version range in chunks and resumes nowhere once done', async () => {
    const reads = route('dbRead', answerPairs);

    const out = await call({ tier: 'visibility', chunk: '5' });

    const chunks = reads.filter((r) => r.text.includes('WITH inv AS')).map((r) => r.values);
    expect(chunks).toEqual([
      [0, 5],
      [5, 10],
      [10, 15],
      [15, 20],
    ]);
    expect(out.nextStart).toBeNull();
  });
});
