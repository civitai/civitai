import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_RATE_LIMIT } from '~/shared/constants/feedback.constants';

const { countMock, createMock } = vi.hoisted(() => ({
  countMock: vi.fn(),
  createMock: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { feedback: { count: countMock } },
  dbWrite: { feedback: { create: createMock } },
}));

vi.mock('~/server/flipt/client', () => ({
  getFliptBoolean: vi.fn().mockResolvedValue(false),
  FLIPT_FEATURE_FLAGS: {},
}));

import { createFeedback } from '../feedback.service';

const input = { userId: 1, area: 'bitdex-image-feed' as const, message: 'feed looks wrong' };

describe('createFeedback rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue({ id: 1 });
  });

  it('writes the row when the user is under the hourly cap', async () => {
    countMock.mockResolvedValue(FEEDBACK_RATE_LIMIT.max - 1);

    await expect(createFeedback(input)).resolves.toEqual({ id: 1 });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with TOO_MANY_REQUESTS at the cap, without writing', async () => {
    countMock.mockResolvedValue(FEEDBACK_RATE_LIMIT.max);

    await expect(createFeedback(input)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('counts only the caller’s own recent rows', async () => {
    countMock.mockResolvedValue(0);

    await createFeedback(input);

    const where = countMock.mock.calls[0][0].where;
    expect(where.userId).toBe(1);
    expect(where.createdAt.gt).toBeInstanceOf(Date);
  });
});
