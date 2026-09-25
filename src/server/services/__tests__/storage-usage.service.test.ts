import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  type FetchMediaChunk,
  type StorageUsageRow,
  MEDIA_SIZE_PATTERN,
  claimMediaRollups,
  fetchMediaChunk,
  sumUserMedia,
} from '~/server/services/storage-usage.service';

const lastQuery = (fn: { mock: { calls: unknown[][] } }) => {
  const [strings, ...values] = fn.mock.calls[fn.mock.calls.length - 1] as [
    TemplateStringsArray,
    ...unknown[]
  ];
  return { text: strings.join('?').replace(/\s+/g, ' '), values };
};

describe('media size pattern', () => {
  // Postgres `~` and JS RegExp agree on this pattern (no classes or escapes that differ between them),
  // so the JS check stands in for the SQL one. The value is bound, not inlined, so what is tested here is
  // exactly what Postgres receives.
  const re = new RegExp(MEDIA_SIZE_PATTERN);

  it('sums integer and decimal byte sizes and nothing else', () => {
    expect(['1234', '12.5'].filter((s) => re.test(s))).toEqual(['1234', '12.5']);
    expect(['abc', '', '12.', '.5', '1e5', '-3', '12.5.1'].filter((s) => re.test(s))).toEqual([]);
  });

  it('reaches the chunk query as a bound value, not as SQL text', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([]);
    await fetchMediaChunk(1, 0, 10);
    const { text, values } = lastQuery(dbMock.dbRead.$queryRaw);
    expect(values).toContain(MEDIA_SIZE_PATTERN);
    expect(text).toContain('c.size ~ ? THEN');
  });
});

describe('claimMediaRollups', () => {
  // DECISION, 2026-09-25: a creator who re-requests while their run is in flight does NOT get a second
  // run. The in-flight run finishes with imagesComputedAt = now(), later than the new request, so the
  // refresh is already satisfied. Adding `OR "imagesStartedAt" < "imagesRequestedAt"` to the claim would
  // start a second concurrent Image scan of the same creator. Don't add it back.
  it('does not reclaim an in-flight rollup because it was requested again', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([]);
    await claimMediaRollups();
    const { text } = lastQuery(dbMock.dbWrite.$queryRaw);
    expect(text).not.toMatch(/"imagesStartedAt"\s*<\s*"imagesRequestedAt"/);
    expect(text).toContain(
      `("imagesStartedAt" IS NULL OR "imagesStartedAt" < now() - interval '10 minutes')`
    );
  });

  // The pending index is partial; the planner uses it only when the query states its predicate.
  it('repeats the partial index predicate verbatim', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([]);
    await claimMediaRollups();
    const { text } = lastQuery(dbMock.dbWrite.$queryRaw);
    const predicate = '"imagesComputedAt" IS NULL OR "imagesRequestedAt" > "imagesComputedAt"';
    expect(text).toContain(`WHERE (${predicate}) AND`);
    expect(text).toContain('FOR UPDATE SKIP LOCKED');

    const migration = readFileSync(
      path.resolve(
        __dirname,
        '../../../../packages/civitai-db-schema/prisma/migrations/20260925150000_user_storage_usage/migration.sql'
      ),
      'utf8'
    ).replace(/\s+/g, ' ');
    expect(migration).toContain(
      `CREATE INDEX "UserStorageRollup_pending_idx" ON "UserStorageRollup" ("imagesRequestedAt") WHERE ${predicate};`
    );
  });
});

type FakeImage = {
  id: number;
  kind: string;
  publicStatus: 'public' | 'notPublic';
  month: string;
  size: number;
};

// Mirrors fetchMediaChunk's SQL: the next `limit` images after `afterId` by id, grouped.
function fakeChunks(images: FakeImage[]) {
  const calls: number[] = [];
  const fetch: FetchMediaChunk = async (_userId, afterId, limit) => {
    calls.push(afterId);
    const slice = images
      .filter((i) => i.id > afterId)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
    const groups = new Map<string, Omit<StorageUsageRow, 'userId'>>();
    for (const i of slice) {
      const key = `${i.kind}|${i.publicStatus}|${i.month}`;
      const g = groups.get(key) ?? {
        kind: i.kind,
        publicStatus: i.publicStatus,
        baseModel: '',
        month: i.month,
        fileCount: 0,
        bytes: 0n,
      };
      g.fileCount += 1;
      g.bytes += BigInt(i.size);
      groups.set(key, g);
    }
    return {
      rows: slice.length,
      lastId: slice.length ? slice[slice.length - 1].id : afterId,
      buckets: [...groups.values()],
    };
  };
  return { fetch, calls };
}

const byKey = (rows: StorageUsageRow[]) =>
  Object.fromEntries(
    rows.map((r) => [`${r.kind}|${r.publicStatus}|${r.month}`, [r.fileCount, r.bytes]])
  );

// Ids are sparse and one month straddles every chunk boundary, which is where a lost or
// double-counted row would show.
const IMAGES: FakeImage[] = [
  { id: 10, kind: 'image', publicStatus: 'public', month: '2026-01-01', size: 100 },
  { id: 11, kind: 'image', publicStatus: 'public', month: '2026-01-01', size: 200 },
  { id: 40, kind: 'video', publicStatus: 'public', month: '2026-01-01', size: 5000 },
  { id: 41, kind: 'image', publicStatus: 'notPublic', month: '2026-01-01', size: 7 },
  { id: 90, kind: 'image', publicStatus: 'public', month: '2026-01-01', size: 300 },
  { id: 91, kind: 'image', publicStatus: 'public', month: '2026-02-01', size: 400 },
  { id: 300, kind: 'video', publicStatus: 'public', month: '2026-02-01', size: 6000 },
];

describe('sumUserMedia', () => {
  it('adds chunked partial sums up to exactly the single-pass totals', async () => {
    const single = await sumUserMedia(1, fakeChunks(IMAGES).fetch, { chunkRows: 1000 });
    const chunked = fakeChunks(IMAGES);
    const result = await sumUserMedia(1, chunked.fetch, { chunkRows: 2 });

    expect(chunked.calls).toEqual([0, 11, 41, 91]);
    expect(byKey(result)).toEqual(byKey(single));
    expect(byKey(result)).toEqual({
      'image|public|2026-01-01': [3, 600n],
      'image|notPublic|2026-01-01': [1, 7n],
      'video|public|2026-01-01': [1, 5000n],
      'image|public|2026-02-01': [1, 400n],
      'video|public|2026-02-01': [1, 6000n],
    });
    expect(result.every((r) => r.userId === 1)).toBe(true);
  });

  it('stops on the empty chunk after an exact multiple of the chunk size', async () => {
    const six = IMAGES.slice(0, 6);
    const chunked = fakeChunks(six);
    const result = await sumUserMedia(1, chunked.fetch, { chunkRows: 3 });
    expect(chunked.calls).toEqual([0, 40, 91]);
    expect(result.reduce((n, r) => n + r.fileCount, 0)).toBe(6);
  });

  it('throws instead of writing a partial total when the chunk cap is reached', async () => {
    const endless: FetchMediaChunk = async (_u, afterId, limit) => ({
      rows: limit,
      lastId: afterId + limit,
      buckets: [],
    });
    await expect(sumUserMedia(1, endless, { chunkRows: 5, maxChunks: 4 })).rejects.toThrow(
      'more than 20 media rows'
    );
  });

  it('returns nothing for a creator with no media', async () => {
    const empty = fakeChunks([]);
    expect(await sumUserMedia(1, empty.fetch)).toEqual([]);
    expect(empty.calls).toEqual([0]);
  });
});
