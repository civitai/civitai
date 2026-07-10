import { vi, describe, it, expect, beforeEach } from 'vitest';

const { executeRaw, queryRaw } = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  queryRaw: vi.fn().mockResolvedValue([{ count: 0 }]),
}));

vi.mock('~/server/db/client', () => ({
  dbWrite: { $executeRaw: executeRaw, $queryRaw: queryRaw },
  dbRead: {
    $queryRaw: queryRaw,
    model: { findFirst: vi.fn().mockResolvedValue({ userId: 1 }) },
    image: { findFirst: vi.fn().mockResolvedValue({ userId: 1 }) },
  },
}));
vi.mock('~/server/redis/client', () => ({
  redis: { del: vi.fn(), packed: {} },
  sysRedis: { del: vi.fn() },
  REDIS_KEYS: { SYSTEM: { TAG_RULES: 't', CATEGORIES: 'c' } },
  REDIS_SYS_KEYS: { SYSTEM: {} },
}));
vi.mock('~/server/redis/caches', () => ({ imageTagsCache: { bust: vi.fn() } }));
vi.mock('~/server/services/system-cache', () => ({
  getCategoryTags: vi.fn(),
  getReplacedTagIds: vi.fn(),
  getSystemTags: vi.fn().mockResolvedValue([]),
}));
vi.mock('~/server/services/tagsOnImageNew.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenImages: { refreshCache: vi.fn() },
  HiddenModels: { refreshCache: vi.fn() },
  ImplicitHiddenImages: { refreshCache: vi.fn() },
}));
vi.mock('~/server/utils/cache-helpers', () => ({ fetchThroughCache: vi.fn() }));

import { addTagVotes, removeTagVotes, deleteTags } from '../tag.service';

// A tag name crafted to break out of a naive `IN ('...')` interpolation.
const INJECTION = `x') UNION SELECT id FROM "Tag" WHERE ('1'='1`;

/** A Prisma.Sql exposes `.sql` (text with $N placeholders) and `.values` (bound params). */
function sqlTextOf(arg: any): string {
  return typeof arg?.sql === 'string' ? arg.sql : String(arg);
}
function valuesOf(arg: any): unknown[] {
  return Array.isArray(arg?.values) ? arg.values : [];
}

describe('tag.service SQL injection guards', () => {
  beforeEach(() => {
    executeRaw.mockClear();
    queryRaw.mockClear();
  });

  it('removeTagVotes binds tag names as a parameter, never interpolates them', async () => {
    await removeTagVotes({ userId: 5, type: 'image', id: 42, tags: [INJECTION] });

    const arg = executeRaw.mock.calls[0][0];
    expect(sqlTextOf(arg)).not.toContain(INJECTION);
    expect(sqlTextOf(arg)).toContain('ANY');
    // The array of names must appear as a bound value.
    expect(valuesOf(arg)).toContainEqual([INJECTION]);
  });

  it('addTagVotes binds tag names as a parameter in both the insert and the moderation check', async () => {
    await addTagVotes({ userId: 5, type: 'image', id: 42, tags: [INJECTION], vote: 1 });

    const insertArg = executeRaw.mock.calls[0][0];
    expect(sqlTextOf(insertArg)).not.toContain(INJECTION);
    expect(valuesOf(insertArg)).toContainEqual([INJECTION]);

    const modCheckArg = queryRaw.mock.calls[0][0];
    expect(sqlTextOf(modCheckArg)).not.toContain(INJECTION);
    expect(valuesOf(modCheckArg)).toContainEqual([INJECTION]);
  });

  it('deleteTags binds tag names as a parameter', async () => {
    await deleteTags({ tags: [INJECTION] });

    const deleteArg = executeRaw.mock.calls[0][0];
    expect(sqlTextOf(deleteArg)).not.toContain(INJECTION);
    expect(valuesOf(deleteArg)).toContainEqual([INJECTION]);
  });

  it('numeric tag ids bind as an int array (no name subquery)', async () => {
    await removeTagVotes({ userId: 5, type: 'model', id: 42, tags: [7, 8] });

    const arg = executeRaw.mock.calls[0][0];
    expect(sqlTextOf(arg)).toContain('int[]');
    expect(valuesOf(arg)).toContainEqual([7, 8]);
  });
});
