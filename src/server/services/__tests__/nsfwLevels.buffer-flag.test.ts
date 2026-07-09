import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression: `updateModelVersionNsfwLevels` reads a kill-switch from sysRedis
// (`update-system-model-version-nsfw-level`). Pre-fix it compared the reply
// with `!== 'false'`. The HA/Sentinel sysRedis returns a Buffer for
// BLOB_STRING replies, and `Buffer !== 'false'` is always true — so the
// kill-switch silently never fired in sentinel mode. Coercing the Buffer to
// utf8 first restores the intended behavior.
//
// The function builds a Prisma.sql query whose shape depends on the flag:
//   - flag enabled  → no extra clause (system-owned rows are scoped)
//   - flag disabled → `AND m."userId" > 0` is appended
// We assert on the rendered SQL passed to dbWrite.$queryRaw.

// Stub @prisma/client so Prisma.sql / Prisma.raw / Prisma.join are callable
// at SSR import time and produce an inspectable shape. Mirrors the existing
// in-repo pattern (see file-download-lookup.test).
vi.mock('@prisma/client', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    // Concat each static fragment with a placeholder/marker for the
    // interpolated value. Nested sql/raw fragments are inlined verbatim by
    // recursively reading their `.sql` so we can assert on the final shape.
    let out = '';
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < values.length) {
        const v = values[i] as { sql?: string } | undefined;
        if (v && typeof v === 'object' && typeof v.sql === 'string') out += v.sql;
        else out += '?';
      }
    }
    return { sql: out, strings, values };
  };
  const raw = (s: string) => ({ sql: s, values: [] });
  const join = (values: unknown[], separator = ',') => ({
    sql: values.map(() => '?').join(separator),
    values,
  });
  const Prisma = new Proxy(
    { sql, raw, join, empty: { sql: '', values: [] }, validator: () => (x: unknown) => x },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop];
        return {};
      },
    }
  );
  return new Proxy(
    { Prisma, PrismaClient: class PrismaClient {} },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop];
        if (prop === '__esModule') return true;
        return {};
      },
    }
  );
});

const { hGet, queryRaw } = vi.hoisted(() => ({
  hGet: vi.fn(),
  queryRaw: vi.fn(() => Promise.resolve([])),
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { hGet, hSet: vi.fn(), sAdd: vi.fn(), sMembers: vi.fn(), del: vi.fn() },
  REDIS_SYS_KEYS: { SYSTEM: { FEATURES: 'system:features' } },
  REDIS_SUB_KEYS: {},
}));

vi.mock('~/server/db/client', () => ({
  dbWrite: { $queryRaw: queryRaw },
  dbRead: {},
}));

// Stub the search-index named exports the service module imports at load.
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  bountiesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  comicsSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

vi.mock('~/server/services/job-queue.service', () => ({
  enqueueJobs: vi.fn(() => Promise.resolve(undefined)),
}));

import { updateModelVersionNsfwLevels } from '~/server/services/nsfwLevels.service';

// Pull the rendered SQL out of a Prisma.sql Sql object. Prisma's Sql exposes
// `.strings` (the static fragments) — joining them gives us the literal query
// shape we want to assert on, independent of bound parameters.
function getRenderedSql(): string {
  expect(queryRaw).toHaveBeenCalledTimes(1);
  const arg = queryRaw.mock.calls[0][0] as { sql?: string; strings?: readonly string[] };
  if (arg && typeof arg.sql === 'string') return arg.sql;
  if (arg && Array.isArray(arg.strings)) return arg.strings.join(' ');
  return JSON.stringify(arg);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateModelVersionNsfwLevels — sysRedis Buffer-vs-string flag', () => {
  it('Buffer("false") disables the system-owned update (was silently always-on pre-fix)', async () => {
    hGet.mockResolvedValue(Buffer.from('false', 'utf8'));

    await updateModelVersionNsfwLevels([1, 2, 3]);

    const sql = getRenderedSql();
    // Disabled flag → SQL must include the scope clause.
    expect(sql).toContain('AND m."userId" > 0');
  });

  it('Buffer("true") enables the system-owned update', async () => {
    hGet.mockResolvedValue(Buffer.from('true', 'utf8'));

    await updateModelVersionNsfwLevels([1, 2, 3]);

    const sql = getRenderedSql();
    // Enabled flag → no scope clause appended.
    expect(sql).not.toContain('AND m."userId" > 0');
  });

  it('string "false" disables the system-owned update (legacy single-pod, unchanged)', async () => {
    hGet.mockResolvedValue('false');

    await updateModelVersionNsfwLevels([1, 2, 3]);

    const sql = getRenderedSql();
    expect(sql).toContain('AND m."userId" > 0');
  });

  it('null hGet (default) enables the system-owned update', async () => {
    hGet.mockResolvedValue(null);

    await updateModelVersionNsfwLevels([1, 2, 3]);

    const sql = getRenderedSql();
    expect(sql).not.toContain('AND m."userId" > 0');
  });
});
