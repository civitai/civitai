import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { userFollowsCache } from '~/server/redis/caches';
import {
  clearHidden,
  getHiddenModelsForUser,
  HiddenModels,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import { UserEngagementType } from '~/shared/utils/prisma/enums';

/**
 * "Unhide all" must leave the user's other filters alone (868m9dgz4). ModelEngagement and
 * UserEngagement hold one row per pair whose type may be Favorite, Notify, Mute, Follow or
 * Block, so the Hide filter is what keeps a bulk clear from wiping those. The cache must be
 * dropped AFTER the delete: refreshed first, it refills from the old rows and the clear looks
 * like a no-op until the hash expires.
 */

const userId = 42;
const sqlOf = (call: unknown[]) => {
  const [first, ...rest] = call as [{ sql?: string; values?: unknown[] } | TemplateStringsArray];
  if ('sql' in first && first.sql) return { sql: first.sql, values: first.values ?? [] };
  return { sql: (first as TemplateStringsArray).join('?'), values: rest };
};

describe('clearHidden', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.spyOn(HiddenModels, 'refreshCache').mockResolvedValue(undefined);
    vi.spyOn(HiddenUsers, 'refreshCache').mockResolvedValue(undefined);
    vi.spyOn(userFollowsCache, 'refresh').mockResolvedValue(undefined as never);
  });

  it('models: deletes only the caller’s Hide rows, in batches, then drops the cache', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(5000).mockResolvedValueOnce(12);

    await expect(clearHidden({ userId, kind: 'model' })).resolves.toEqual({ count: 5012 });

    const deletes = dbMock.dbWrite.$executeRaw.mock.calls;
    expect(deletes).toHaveLength(2);
    const { sql, values } = sqlOf(deletes[0]);
    expect(sql).toMatch(/DELETE FROM "ModelEngagement"/);
    expect(sql.match(/"userId" = (\?|\$\d+) AND type = 'Hide'/g)).toHaveLength(2);
    expect(values.filter((v) => v === userId)).toHaveLength(2);
    expect(dbMock.dbWrite.userEngagement.deleteMany).not.toHaveBeenCalled();

    expect(HiddenModels.refreshCache).toHaveBeenCalledTimes(1);
    expect(HiddenModels.refreshCache).toHaveBeenCalledWith({ userId });
    const lastDelete = Math.max(...dbMock.dbWrite.$executeRaw.mock.invocationCallOrder);
    expect(vi.mocked(HiddenModels.refreshCache).mock.invocationCallOrder[0]).toBeGreaterThan(
      lastDelete
    );
  });

  it('users: deletes only the caller’s Hide rows, never Follow or Block, then drops the cache', async () => {
    dbMock.dbWrite.userEngagement.deleteMany.mockResolvedValue({ count: 2 });

    await clearHidden({ userId, kind: 'user' });

    expect(dbMock.dbWrite.userEngagement.deleteMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.userEngagement.deleteMany).toHaveBeenCalledWith({
      where: { userId, type: UserEngagementType.Hide },
    });
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();

    expect(HiddenUsers.refreshCache).toHaveBeenCalledTimes(1);
    expect(vi.mocked(HiddenUsers.refreshCache).mock.invocationCallOrder[0]).toBeGreaterThan(
      dbMock.dbWrite.userEngagement.deleteMany.mock.invocationCallOrder[0]
    );
  });
});

describe('getHiddenModelsForUser', () => {
  const rows = (ids: number[]) =>
    ids.map((id) => ({ id, name: `model-${id}`, type: 'LORA', username: 'creator' }));

  beforeEach(() => vi.clearAllMocks());

  it('reads only the caller’s live Hide rows, pages downward from the cursor, escapes the search', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);

    await getHiddenModelsForUser({ userId, limit: 2, cursor: 99, query: '50%_off' });

    const { sql, values } = sqlOf(dbMock.dbRead.$queryRaw.mock.calls[0]);
    expect(sql).toMatch(/me\."userId" = (\?|\$\d+)/);
    expect(sql).toMatch(/me\.type = 'Hide'/);
    expect(sql).toMatch(/me\."modelId" < (\?|\$\d+)/);
    expect(sql).toMatch(/ORDER BY me\."modelId" DESC/);
    expect(sql).toMatch(/ORDER BY p\.id DESC\s*$/);
    expect(sql).toMatch(/m\.status != (\?|\$\d+)::"ModelStatus"/);
    expect(values).toContain('Deleted');
    expect(values).toContain(userId);
    expect(values).toContain(99);
    expect(values).toContain('%50\\%\\_off%');
    // One row past the page, so `nextCursor` can tell another page exists.
    expect(values).toContain(3);
  });

  it('withholds name, type and creator of models the viewer can no longer see', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);

    await getHiddenModelsForUser({ userId, limit: 2, query: 'draft' });

    const { sql, values } = sqlOf(dbMock.dbRead.$queryRaw.mock.calls[0]);
    const visible =
      /\(\s*\(m\.status = (\?|\$\d+)::"ModelStatus"\s+AND m\.availability != (\?|\$\d+)::"Availability"\)\s+OR m\."userId" = (\?|\$\d+)\s*\)/;
    for (const column of ['m\\.name', 'm\\.type::text', 'm\\."userId"'])
      expect(sql).toMatch(new RegExp(`CASE WHEN ${visible.source} THEN ${column} END`));
    // A search must not match hidden-from-viewer names either, or its hit count leaks them.
    expect(sql).toMatch(new RegExp(`${visible.source} AND m\\.name ILIKE`));
    expect(values).toEqual(expect.arrayContaining(['Published', 'Private']));
  });

  it('returns a cursor at the last item when another page exists', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue(rows([30, 20, 10]) as never);

    const result = await getHiddenModelsForUser({ userId, limit: 2 });

    expect(result.items.map((x) => x.id)).toEqual([30, 20]);
    expect(result.nextCursor).toBe(20);
  });

  it('returns no cursor on the last page', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue(rows([30, 20]) as never);

    const result = await getHiddenModelsForUser({ userId, limit: 2 });

    expect(result.nextCursor).toBeUndefined();
  });
});
