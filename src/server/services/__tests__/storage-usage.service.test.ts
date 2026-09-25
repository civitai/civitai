import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { MediaType } from '~/shared/utils/prisma/enums';
import {
  type FetchMediaChunk,
  type StorageUsageRow,
  MEDIA_JOB_LOCK_SECONDS,
  MEDIA_LEASE_MINUTES,
  MEDIA_SIZE_PATTERN,
  MEDIA_TICK_BUDGET_MS,
  MEDIA_STORAGE_KINDS,
  NIGHTLY_STORAGE_KINDS,
  claimMediaRollups,
  fetchMediaChunk,
  runMediaStorageUsage,
  runNightlyStorageUsage,
  sumUserMedia,
  toMediaChunk,
  writeMediaUsage,
  writeNightlyUsage,
} from '~/server/services/storage-usage.service';

const executed = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.map(([strings, ...values]) => ({
    text: (strings as unknown as TemplateStringsArray).join('?').replace(/\s+/g, ' '),
    values,
  }));

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

  // An unbounded client-supplied size would overflow the bigint sum and fail the creator's rollup forever.
  it('rejects a size too large to be a real file', () => {
    expect(re.test('9999999999999')).toBe(true);
    expect(re.test('99999999999999')).toBe(false);
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
    const where = text.slice(text.indexOf('WHERE ('), text.indexOf(' ORDER BY'));
    expect(where).toBe(
      `WHERE ("imagesComputedAt" IS NULL OR "imagesRequestedAt" > "imagesComputedAt") AND "imagesRequestedAt" IS NOT NULL AND ("imagesStartedAt" IS NULL OR "imagesStartedAt" < timezone('UTC', now()) - make_interval(mins => ?))`
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
    // Full chunks for 50 calls, then empty: if the cap is removed the loop still ends, and the call
    // count says so instead of the run hanging.
    let calls = 0;
    const endless: FetchMediaChunk = async (_u, afterId, limit) => {
      calls++;
      return { rows: calls > 50 ? 0 : limit, lastId: afterId + limit, buckets: [] };
    };
    await expect(sumUserMedia(1, endless, { chunkRows: 5, maxChunks: 4 })).rejects.toThrow(
      'more than 20 media rows'
    );
    expect(calls).toBe(4);
  });

  it('returns nothing for a creator with no media', async () => {
    const empty = fakeChunks([]);
    expect(await sumUserMedia(1, empty.fetch)).toEqual([]);
    expect(empty.calls).toEqual([0]);
  });
});

describe('fetchMediaChunk', () => {
  // The loop's stop condition and cursor come from window totals repeated on every row, not from the
  // number of grouped rows returned.
  it('takes rows and lastId from the window totals, not from the bucket count', () => {
    const chunk = toMediaChunk(
      [
        {
          kind: 'image',
          publicStatus: 'public',
          month: '2026-01-01',
          fileCount: 30,
          bytes: '300',
          chunkRows: 50,
          lastId: 999,
        },
        {
          kind: 'video',
          publicStatus: 'public',
          month: '2026-01-01',
          fileCount: 20,
          bytes: '12345678901234567890',
          chunkRows: 50,
          lastId: 999,
        },
      ],
      7
    );
    expect(chunk.rows).toBe(50);
    expect(chunk.lastId).toBe(999);
    expect(chunk.buckets.map((b) => b.bytes)).toEqual([300n, 12345678901234567890n]);
    expect(toMediaChunk([], 7)).toEqual({ rows: 0, lastId: 7, buckets: [] });
  });

  it('pages by id and counts the whole chunk', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([]);
    await fetchMediaChunk(1, 0, 10);
    const { text } = lastQuery(dbMock.dbRead.$queryRaw);
    expect(text).toContain('AND i.id > ? ORDER BY i.id LIMIT ?');
    expect(text).toContain('(sum(count(*)) OVER ())::int AS "chunkRows"');
    expect(text).toContain('(max(max(c.id)) OVER ())::int AS "lastId"');
  });
});

describe('which job owns which rows', () => {
  // Each job deletes only its own kinds. If either DELETE took the other's, every nightly run would wipe
  // image totals (or every media run the model totals) with nothing on the page to say so.
  it('keeps the two kind sets disjoint and the media set equal to MediaType', () => {
    const nightly = new Set<string>(NIGHTLY_STORAGE_KINDS);
    expect(MEDIA_STORAGE_KINDS.filter((k) => nightly.has(k))).toEqual([]);
    expect([...MEDIA_STORAGE_KINDS].sort()).toEqual(Object.values(MediaType).sort());
  });

  it('prunes only nightly kinds in the nightly write', async () => {
    dbMock.dbWrite.$executeRaw.mockClear();
    await writeNightlyUsage(0, 100, []);
    const prune = executed().find((q) => q.text.includes('NOT IN ('));
    expect(prune?.values).toContainEqual([...NIGHTLY_STORAGE_KINDS]);
  });

  it('replaces only media kinds, and marks the rollup done, in the media write', async () => {
    dbMock.dbWrite.$executeRaw.mockClear();
    await writeMediaUsage(5, []);
    const statements = executed();
    const del = statements.find((q) => q.text.startsWith(' DELETE'));
    expect(del?.values).toEqual([5, [...MEDIA_STORAGE_KINDS]]);
    const done = statements.find((q) => q.text.includes('UPDATE "UserStorageRollup"'));
    expect(done?.text).toContain(
      'SET "imagesComputedAt" = timezone(\'UTC\', now()) WHERE "userId" = ?'
    );
    expect(done?.values).toEqual([5]);
  });
});

describe('runNightlyStorageUsage', () => {
  it('logs a failing range and still walks every other one, then fails the run', async () => {
    const seen: number[] = [];
    const logged: string[] = [];
    await expect(
      runNightlyStorageUsage({
        maxUserId: async () => 250_000,
        fetchRange: async (lo) => {
          if (lo === 100_000) throw new Error('canceling statement due to conflict with recovery');
          return [];
        },
        writeRange: async (lo) => {
          seen.push(lo);
        },
        log: (m) => logged.push(m),
      })
    ).rejects.toThrow('1 of 3 range(s) failed');
    expect(seen).toEqual([0, 200_000]);
    expect(logged).toEqual(['storage-usage-nightly: range [100000, 200000) failed']);
  });

  it('covers the highest user id', async () => {
    const seen: number[] = [];
    await runNightlyStorageUsage({
      maxUserId: async () => 200_000,
      fetchRange: async () => [],
      writeRange: async (lo, hi) => {
        seen.push(lo, hi);
      },
      log: () => undefined,
    });
    expect(seen).toEqual([0, 100_000, 100_000, 200_000, 200_000, 300_000]);
  });
});

describe('runMediaStorageUsage', () => {
  const queue = (ids: number[]) => async () => {
    const next = ids.shift();
    return next === undefined ? [] : [next];
  };

  // One creator a minute capped the queue at 1,440 a day while every dashboard visit adds to it.
  it('keeps claiming within one tick until the queue is empty', async () => {
    const written: number[] = [];
    const result = await runMediaStorageUsage({
      claim: queue([1, 2, 3]),
      sum: async () => [],
      write: async (userId) => {
        written.push(userId);
      },
      log: () => undefined,
    });
    expect(written).toEqual([1, 2, 3]);
    expect(result).toEqual({ processed: 3 });
  });

  it('stops claiming once the tick budget is spent', async () => {
    let clock = 0;
    const written: number[] = [];
    await runMediaStorageUsage({
      claim: queue([1, 2, 3]),
      sum: async () => {
        clock += 60_000;
        return [];
      },
      write: async (userId) => {
        written.push(userId);
      },
      log: () => undefined,
      budgetMs: 90_000,
      now: () => clock,
    });
    expect(written).toEqual([1, 2]);
  });

  it('writes the users it can and fails the run for the one it cannot', async () => {
    const written: number[] = [];
    await expect(
      runMediaStorageUsage({
        claim: queue([1, 2]),
        sum: async (userId) => {
          if (userId === 1) throw new Error('boom');
          return [];
        },
        write: async (userId) => {
          written.push(userId);
        },
        log: () => undefined,
      })
    ).rejects.toThrow('1 rollup(s) failed');
    expect(written).toEqual([2]);
  });
});

describe('media lease', () => {
  // The lease must outlast both the job lock and a tick's budget, or the next tick reclaims a creator
  // whose scan is still running and a second Image scan starts for them.
  it('outlasts the job lock, which outlasts the tick budget, and is what the claim binds', async () => {
    expect(MEDIA_LEASE_MINUTES * 60).toBeGreaterThan(MEDIA_JOB_LOCK_SECONDS);
    expect(MEDIA_TICK_BUDGET_MS / 1000).toBeLessThan(MEDIA_JOB_LOCK_SECONDS);
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([]);
    await claimMediaRollups();
    expect(lastQuery(dbMock.dbWrite.$queryRaw).values).toContain(MEDIA_LEASE_MINUTES);
  });
});

describe('nightly write order and pruning', () => {
  it('snapshots after the usage transaction commits, in its own statement', async () => {
    dbMock.dbWrite.$executeRaw.mockClear();
    dbMock.dbWrite.$transaction.mockClear();
    await writeNightlyUsage(0, 100, []);
    const calls = executed();
    expect(calls[calls.length - 1].text).toContain('INSERT INTO "UserStorageSnapshot"');
    const snapshotOrder = dbMock.dbWrite.$executeRaw.mock.invocationCallOrder.at(-1) as number;
    expect(dbMock.dbWrite.$transaction.mock.invocationCallOrder[0]).toBeLessThan(snapshotOrder);
  });

  it('drops snapshots and rollup state of deleted users, not only their usage', async () => {
    dbMock.dbWrite.$executeRaw.mockClear();
    await writeNightlyUsage(0, 100, []);
    const pruned = executed()
      .filter((q) => q.text.includes('NOT EXISTS (SELECT 1 FROM "User"'))
      .map((q) => q.text.match(/DELETE FROM "(\w+)"/)?.[1]);
    expect(pruned).toEqual(['UserStorageUsage', 'UserStorageSnapshot', 'UserStorageRollup']);
  });
});
