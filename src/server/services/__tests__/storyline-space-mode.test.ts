import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setStorylineSpaceMode } from '~/server/services/storyline-placement.service';

const upsert = vi.fn();
const tx = { placementSpace: { upsert } };

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({});
});

/**
 * Called by the storyline service inside the transaction that marks a
 * storyline Complete, so the status and the space close together.
 */
describe('setStorylineSpaceMode', () => {
  it('writes the mode on the storyline level of the space, through the transaction', async () => {
    await setStorylineSpaceMode({ storylineId: 9, mode: 'off' }, tx as never);

    expect(upsert).toHaveBeenCalledWith({
      where: {
        surface_entityType_entityId: { surface: 'storyline', entityType: 'storyline', entityId: 9 },
      },
      create: { surface: 'storyline', entityType: 'storyline', entityId: 9, mode: 'off' },
      update: { mode: 'off' },
    });
    // Never on its own connection: a write outside the caller's transaction
    // would survive that transaction rolling back.
    expect(dbMock.dbWrite.placementSpace.upsert).not.toHaveBeenCalled();
  });

  // Mode only: reopening a completed storyline must not reset its price.
  it('leaves the price alone', async () => {
    await setStorylineSpaceMode({ storylineId: 9, mode: 'review' }, tx as never);

    expect(upsert.mock.calls[0][0].update).toEqual({ mode: 'review' });
    expect(upsert.mock.calls[0][0].create).not.toHaveProperty('price');
  });

  it('refuses auto, which would put continuations live unreviewed', async () => {
    await expect(
      setStorylineSpaceMode({ storylineId: 9, mode: 'auto' as never }, tx as never)
    ).rejects.toThrow(/not a mode a storyline may be in/);
    expect(upsert).not.toHaveBeenCalled();
  });
});
