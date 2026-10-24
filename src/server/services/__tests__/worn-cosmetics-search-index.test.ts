import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

const { equipCosmetic, unequipCosmeticByType } = await import('~/server/services/user.service');
const { usersSearchIndex } = await import('~/server/search-index/users.search-index');

const USER = 21;
const BADGE = 3433;

/**
 * Search results and user pickers render the cosmetics stored on each user's search document. The
 * incremental sync re-pulls an existing user only when their id is queued, so an equip that does
 * not queue leaves the old badge and nameplate showing there until something else queues them.
 */
describe('changing what a user wears queues their search document', () => {
  let queue: MockInstance<typeof usersSearchIndex.queueUpdate>;

  beforeEach(() => {
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue([
      { obtainedAt: new Date(), cosmetic: { type: 'Badge', data: { url: 'art' } } },
    ]);
    dbMock.dbWrite.userCosmetic.updateMany.mockResolvedValue({ count: 1 });
    queue = vi.spyOn(usersSearchIndex, 'queueUpdate').mockResolvedValue();
  });

  afterEach(() => {
    queue.mockRestore();
  });

  it('queues the user once the equip has committed, not before', async () => {
    let commit!: () => void;
    dbMock.dbWrite.$transaction.mockImplementationOnce(
      () => new Promise<void>((resolve) => (commit = resolve))
    );

    const equipping = equipCosmetic({ userId: USER, cosmeticId: BADGE });
    await vi.waitFor(() => expect(dbMock.dbWrite.$transaction).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue).not.toHaveBeenCalled();

    commit();
    await equipping;

    expect(queue).toHaveBeenCalledWith([{ id: USER, action: SearchIndexUpdateQueueAction.Update }]);
  });

  it('still completes the equip when the enqueue fails', async () => {
    queue.mockRejectedValue(new Error('redis down'));

    await expect(equipCosmetic({ userId: USER, cosmeticId: BADGE })).resolves.toBeUndefined();
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('queues the user after an unequip', async () => {
    await unequipCosmeticByType({ userId: USER, type: 'Badge' });

    expect(queue).toHaveBeenCalledWith([{ id: USER, action: SearchIndexUpdateQueueAction.Update }]);
  });
});
