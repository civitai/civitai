import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Award from '~/server/events/points/award';

// `toggleReaction` is where an Image or Article reaction is created and deleted. What this pins:
// the create awards, deleting the actor's last reaction removes, and a failing points call never
// fails the reaction.

const { awardEventPoints, removeEventPoints, hatted } = vi.hoisted(() => ({
  awardEventPoints: vi.fn(async (..._a: unknown[]) => undefined),
  removeEventPoints: vi.fn(async (..._a: unknown[]) => undefined),
  hatted: new Set<string>(),
}));

vi.mock('~/server/events/points/award', async (importOriginal) => ({
  ...(await importOriginal<typeof Award>()),
  awardEventPoints,
  removeEventPoints,
  isHattedEntity: (entityType: string, entityId: number) => hatted.has(`${entityType}:${entityId}`),
}));
vi.mock('~/server/db/db-lag-helpers', () => ({ getDbWithoutLag: async () => dbMock.dbWrite }));
vi.mock('~/server/services/block-check.service', () => ({
  throwIfBlockedByEntityOwner: vi.fn(async () => undefined),
}));

import { toggleReaction } from '~/server/services/reaction.service';

const db = dbMock.dbWrite;
const USER = 5;
const like = { entityType: 'image', entityId: 7, userId: USER, reaction: 'Like' } as const;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Resolves to 'pending' if `call` has not settled by the time pending microtasks drain.
const raceSettle = (call: Promise<unknown>) =>
  Promise.race([call.then(() => 'done'), settle().then(() => 'pending')]);

beforeEach(() => {
  vi.clearAllMocks();
  hatted.clear();
  hatted.add('Image:7');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('toggleReaction event points', () => {
  it('awards the reaction it creates', async () => {
    db.imageReaction.findFirst.mockResolvedValue(null);

    expect(await toggleReaction(like)).toBe('created');
    await settle();

    expect(awardEventPoints).toHaveBeenCalledWith([
      {
        type: 'reaction',
        actorId: USER,
        entityType: 'Image',
        entityId: 7,
        time: expect.any(Date),
        sourceId: `ImageReaction:7:${USER}`,
      },
    ]);
  });

  it("removes when the deleted reaction was the actor's last on the image", async () => {
    db.imageReaction.findFirst.mockResolvedValue({ id: 1 });
    db.imageReaction.deleteMany.mockResolvedValue({ count: 1 });
    db.imageReaction.count.mockResolvedValue(0);

    expect(await toggleReaction(like)).toBe('removed');
    await settle();

    expect(removeEventPoints).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'reaction', sourceId: `ImageReaction:7:${USER}` }),
    ]);
  });

  it('sends nothing for a delete that matched no row', async () => {
    db.imageReaction.findFirst.mockResolvedValue({ id: 1 });
    db.imageReaction.deleteMany.mockResolvedValue({ count: 0 });

    expect(await toggleReaction(like)).toBe('noop');
    await settle();

    expect(db.imageReaction.count).not.toHaveBeenCalled();
    expect(removeEventPoints).not.toHaveBeenCalled();
  });

  it('is not failed by a failing points call', async () => {
    db.imageReaction.findFirst.mockResolvedValue(null);
    awardEventPoints.mockRejectedValueOnce(new Error('redis down'));

    await expect(toggleReaction(like)).resolves.toBe('created');
    await settle();
    expect(awardEventPoints).toHaveBeenCalledTimes(1);
  });
});

describe('the reaction does not wait on points', () => {
  it('resolves while the points call is still pending', async () => {
    db.imageReaction.findFirst.mockResolvedValue(null);
    awardEventPoints.mockReturnValueOnce(new Promise(() => undefined));

    expect(await raceSettle(toggleReaction(like))).toBe('done');
    expect(awardEventPoints).toHaveBeenCalledTimes(1);
  });
});
