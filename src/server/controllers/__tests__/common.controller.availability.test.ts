import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateEntityAvailabilityHandler } from '~/server/controllers/common.controller';
import { articlesSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { Availability } from '~/shared/utils/prisma/enums';

afterEach(() => vi.restoreAllMocks());

describe('updateEntityAvailabilityHandler for an article', () => {
  it.each([
    [Availability.Private, SearchIndexUpdateQueueAction.Delete],
    [Availability.Unsearchable, SearchIndexUpdateQueueAction.Delete],
    [Availability.Public, SearchIndexUpdateQueueAction.Update],
  ])('queues the search document for each availability (case %#)', async (availability, action) => {
    const queue = vi
      .spyOn(articlesSearchIndex, 'queueUpdate')
      .mockResolvedValue(undefined as never);
    await updateEntityAvailabilityHandler({
      ctx: {} as never,
      input: { availability, entityId: 7, entityType: 'Article' },
    });
    expect(queue).toHaveBeenCalledWith([{ id: 7, action }], { reason: 'availability' });
  });
});
