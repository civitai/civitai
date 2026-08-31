import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.hoisted(() => vi.fn());

vi.mock('~/server/db/client', () => ({
  dbRead: { tool: { findMany } },
}));

import { getToolIdsByAliasesOrNames } from '~/server/services/tool.service';

describe('getToolIdsByAliasesOrNames', () => {
  beforeEach(() => vi.resetAllMocks());

  it('resolves aliases before names in one bounded query', async () => {
    findMany.mockResolvedValue([
      { id: 11, alias: 'Editor', name: 'Different Name' },
      { id: 22, alias: null, name: 'Post Processor' },
    ]);

    await expect(
      getToolIdsByAliasesOrNames(['editor', 'Post Processor', 'Unknown'])
    ).resolves.toEqual([11, 22]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { alias: { in: ['editor', 'Post Processor', 'Unknown'], mode: 'insensitive' } },
          { name: { in: ['editor', 'Post Processor', 'Unknown'], mode: 'insensitive' } },
        ],
      },
      select: { id: true, alias: true, name: true },
    });
  });

  it('does not query for an empty declaration', async () => {
    await expect(getToolIdsByAliasesOrNames([])).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('bounds direct callers before querying', async () => {
    findMany.mockResolvedValue([]);
    const names = Array.from({ length: 30 }, (_, index) => `Tool ${index}`);

    await getToolIdsByAliasesOrNames(names);

    const query = findMany.mock.calls[0][0];
    expect(query.where.OR[0].alias.in).toEqual(names.slice(0, 10));
    expect(query.where.OR[1].name.in).toEqual(names.slice(0, 10));
  });
});
