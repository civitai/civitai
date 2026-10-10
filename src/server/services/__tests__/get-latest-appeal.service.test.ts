import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getLatestAppeal } from '~/server/services/report.service';
import { EntityType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockFindFirst = dbMock.dbRead.appeal.findFirst;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getLatestAppeal', () => {
  it('queries the newest appeal by this user on this entity', async () => {
    mockFindFirst.mockResolvedValue({ id: 3, status: 'Pending', resolvedAt: null });

    const result = await getLatestAppeal({
      entityType: EntityType.Image,
      entityId: 2186217,
      userId: 602767,
    });

    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { entityType: EntityType.Image, entityId: 2186217, userId: 602767 },
      orderBy: { id: 'desc' },
      select: { id: true, status: true, resolvedAt: true },
    });
    expect(result).toEqual({ id: 3, status: 'Pending', resolvedAt: null });
  });

  it('returns null when the user has no appeal on the entity', async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await getLatestAppeal({
      entityType: EntityType.Model,
      entityId: 2186217,
      userId: 602767,
    });

    expect(result).toBeNull();
  });
});
