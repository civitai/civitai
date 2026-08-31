import { vi, describe, it, expect, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The db and redis clients come from the canonical shared mocks.
//
// The old direct db mock aliased ONE `$queryRaw` spy onto both clients, which
// hid which tier each statement runs on. Resolved by reading the entry points
// instead: every statement these tests assert about is `dbWrite.$executeRaw`
// (`removeTagVotes` tag.service.ts:649, `addTagVotes` :696, `deleteTags` :946),
// and the moderation-tag check `addTagVotes` makes afterwards is
// `dbRead.$queryRaw` (:711). So the two are bound to the client that actually
// runs them, and a statement moving tiers now shows up as a missing call rather
// than passing on the alias.
const executeRaw = dbMock.dbWrite.$executeRaw;
const queryRaw = dbMock.dbRead.$queryRaw;

// `addTagVotes` destructures the first row of the moderation-count read, so the
// fixture the old mock supplied has to be carried over rather than inherited —
// the canonical `$queryRaw` default is an empty array, which would throw there.
queryRaw.mockResolvedValue([{ count: 0 }]);
// The creator-weight lookups; `addTagVotes` reads `creator?.userId` from each.
dbMock.dbRead.model.findFirst.mockResolvedValue({ userId: 1 });
dbMock.dbRead.image.findFirst.mockResolvedValue({ userId: 1 });

vi.mock('~/server/redis/caches', () => ({
  imageTagsCache: { bust: vi.fn() },
  // tag.service now reads/busts the votable-tags cache (#3223) from add/remove/delete
  // vote paths under test — provide fetch + bust so those paths don't hit an
  // undefined cache export.
  modelVotableTagsCache: { fetch: vi.fn().mockResolvedValue([]), bust: vi.fn() },
}));
vi.mock('~/server/services/system-cache', () => ({
  getCategoryTags: vi.fn(),
  getReplacedTagIds: vi.fn(),
  getSystemTags: vi.fn().mockResolvedValue([]),
  clearFeedTagBarTagsCache: vi.fn(),
}));
vi.mock('~/server/services/tagsOnImageNew.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenImages: { refreshCache: vi.fn() },
  HiddenModels: { refreshCache: vi.fn() },
  ImplicitHiddenImages: { refreshCache: vi.fn() },
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(),
  // tag.service now builds a module-scope read-through cache at import time via
  // `queryCache(dbRead, 'getTags', 'v1')` (#3239) — queryCache returns the cached
  // query runner, so the mock returns a callable. bustCacheTag is used by the
  // getTags cache-busting helper.
  queryCache: vi.fn(() => vi.fn()),
  bustCacheTag: vi.fn(),
}));

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
