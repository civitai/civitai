import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The model page needs to tell an owner whether they already have an appeal
 * in flight for a minor flag, without pulling in the whole Appeal row.
 */

const { mockFindFirst } = vi.hoisted(() => ({ mockFindFirst: vi.fn() }));

vi.mock('~/server/db/client', () => ({
  dbRead: { appeal: { findFirst: mockFindFirst } },
  dbWrite: {},
}));

import { getLatestModelAppeal } from '~/server/services/report.service';
import { EntityType } from '~/shared/utils/prisma/enums';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getLatestModelAppeal', () => {
  it('queries the newest Model appeal for the given user, selecting only status and resolvedAt', async () => {
    mockFindFirst.mockResolvedValue({ status: 'Pending', resolvedAt: null });

    const result = await getLatestModelAppeal(2186217, 602767);

    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { entityType: EntityType.Model, entityId: 2186217, userId: 602767 },
      orderBy: { createdAt: 'desc' },
      select: { status: true, resolvedAt: true },
    });
    expect(result).toEqual({ status: 'Pending', resolvedAt: null });
  });

  it('returns null when the user has no appeal on the model', async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await getLatestModelAppeal(2186217, 602767);

    expect(result).toBeNull();
  });
});
