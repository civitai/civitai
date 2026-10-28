import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import type * as PlacementService from '~/server/services/placement.service';

const { placementPriceRange } = vi.hoisted(() => ({ placementPriceRange: vi.fn() }));
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRange,
}));

const { getStorylineSpace, setStorylineSpace } = await import(
  '~/server/services/storyline-placement.service'
);

const OWNER = 1;
const MODERATOR = 2;
const STRANGER = 3;
const w = dbMock.dbWrite;

beforeEach(() => {
  resetSharedMocks();
  placementPriceRange.mockReset();
  placementPriceRange.mockImplementation(async (userId: number) => ({
    min: 0,
    max: userId === OWNER ? 500 : 50,
  }));
  w.storyline.findUnique.mockResolvedValue({ userId: OWNER, status: 'Ongoing' } as never);
});

describe('a storyline price, read by a moderator', () => {
  it("shows the owner's account default and cap, not the moderator's", async () => {
    w.placementSpace.findMany.mockResolvedValue([
      { entityType: 'user', mode: 'review', price: 300 },
    ] as never);
    const space = await getStorylineSpace({
      storylineId: 10,
      userId: MODERATOR,
      isModerator: true,
    });
    expect(w.placementSpace.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        OR: [
          { entityType: 'storyline', entityId: 10 },
          { entityType: 'user', entityId: OWNER },
        ],
      },
    });
    expect(space).toMatchObject({ cap: 500, price: 300 });
  });

  it('refuses anyone else who is not the owner', async () => {
    await expect(getStorylineSpace({ storylineId: 10, userId: STRANGER })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

// Decided with the Storylines lead: the price is the owner's consent to be paid, so a moderator who
// can edit everything else about a storyline still cannot set it. Do not open this with the rest.
describe('a storyline price, set by anyone but the owner', () => {
  it.each([
    ['a moderator', { userId: MODERATOR, isModerator: true }],
    ['a stranger', { userId: STRANGER }],
  ])('is refused for %s', async (_name, caller) => {
    // Sent as the router would if it passed the session's moderator flag through.
    const input = { storylineId: 10, mode: 'review' as const, price: 100, ...caller };
    await expect(setStorylineSpace(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(w.placementSpace.upsert).not.toHaveBeenCalled();
  });
});
