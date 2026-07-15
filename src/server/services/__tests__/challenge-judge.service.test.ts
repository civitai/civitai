import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
vi.mock('~/server/db/client', () => ({
  dbRead: { challengeJudge: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

import { getUserSelectableJudges } from '~/server/services/challenge-judge.service';

beforeEach(() => findMany.mockReset());

describe('getUserSelectableJudges', () => {
  it('returns active userSelectable judges when any exist (single query)', async () => {
    findMany.mockResolvedValueOnce([{ id: 1, name: 'CivBot', bio: null }]);
    const res = await getUserSelectableJudges();
    expect(res).toEqual([{ id: 1, name: 'CivBot', bio: null }]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ active: true, userSelectable: true });
  });

  it('falls back to the name whitelist when no judge is userSelectable', async () => {
    findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 2, name: 'CivChan', bio: 'hi' }]);
    const res = await getUserSelectableJudges();
    expect(res).toEqual([{ id: 2, name: 'CivChan', bio: 'hi' }]);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1][0].where.name.in).toEqual(
      expect.arrayContaining(['CivBot', 'CivChan'])
    );
  });

  it('falls back to the name whitelist when the userSelectable column does not exist yet', async () => {
    findMany
      .mockRejectedValueOnce(Object.assign(new Error('column does not exist'), { code: 'P2022' }))
      .mockResolvedValueOnce([{ id: 3, name: 'CivBot', bio: null }]);
    const res = await getUserSelectableJudges();
    expect(res).toEqual([{ id: 3, name: 'CivBot', bio: null }]);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1][0].where.name.in).toEqual(
      expect.arrayContaining(['CivBot', 'CivChan'])
    );
  });
});
