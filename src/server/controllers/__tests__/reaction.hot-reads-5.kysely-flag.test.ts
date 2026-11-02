import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import type * as ReactionService from '~/server/services/reaction.service';
import type * as CommonService from '~/server/services/common.service';
import type * as CollectionService from '~/server/services/collection.service';
import type * as MetricHelpers from '~/server/utils/metric-helpers';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads5>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// The handler's own reads are under test; the toggle, the access decision, the contest lookup and
// the metric write around them are stubbed.
const { toggleReaction, hasEntityAccess, getContestsFromEntity, updateEntityMetric } = vi.hoisted(
  () => ({
    toggleReaction: vi.fn(),
    hasEntityAccess: vi.fn(),
    getContestsFromEntity: vi.fn(),
    updateEntityMetric: vi.fn(),
  })
);
vi.mock('~/server/services/reaction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactionService>()),
  toggleReaction,
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess,
}));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getContestsFromEntity,
}));
vi.mock('~/server/utils/metric-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof MetricHelpers>()),
  updateEntityMetric,
}));

import * as queries from '@civitai/db-queries/hot-reads-5';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { toggleReactionHandler } from '~/server/controllers/reaction.controller';
import { kyselyRead } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';

/**
 * `reaction.toggle`'s two image reads behind `kysely-hot-reads-5` (reaction.controller.ts): the
 * access check's `postId` and the tracker event's `nsfwLevel` and owner. OFF reads through Prisma
 * only, ON through Kysely on the replica only; a missing image ON still runs the Prisma read, so its
 * error is unchanged. Row parity is in services/__tests__/hot-reads-5.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

const IMAGE = 8301;
const POST = 8402;
const OWNER = 8503;
const VIEWER = 8604;

const input = { entityType: 'image', entityId: IMAGE, reaction: 'Like' } as const;
const ctx = () =>
  ({
    user: { id: VIEWER, isModerator: false },
    ip: '127.0.0.1',
    track: { reaction: vi.fn(async () => undefined) },
  } as never);

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  toggleReaction.mockReset().mockResolvedValue('removed');
  hasEntityAccess.mockReset().mockResolvedValue([{ hasAccess: true }]);
  getContestsFromEntity.mockReset().mockResolvedValue([]);
  updateEntityMetric.mockReset().mockResolvedValue(undefined);
});

describe('toggleReactionHandler behind kysely-hot-reads-5', () => {
  it('OFF: both image reads through Prisma on the replica', async () => {
    dbMock.dbRead.image.findUniqueOrThrow.mockResolvedValue({ id: IMAGE, postId: POST });
    dbMock.dbRead.image.findFirst.mockResolvedValue({ nsfwLevel: 4, userId: OWNER });
    const c = ctx() as { track: { reaction: ReturnType<typeof vi.fn> } };
    await toggleReactionHandler({ ctx: c as never, input });

    expect(flag.mock.calls).toEqual([['kysely-hot-reads-5'], ['kysely-hot-reads-5']]);
    expect(dbMock.dbRead.image.findUniqueOrThrow.mock.calls).toEqual([[{ where: { id: IMAGE } }]]);
    expect(dbMock.dbRead.image.findFirst.mock.calls).toEqual([
      [{ where: { id: IMAGE }, select: { nsfwLevel: true, userId: true } }],
    ]);
    expect(hasEntityAccess.mock.calls[0][0].entityIds).toEqual([POST]);
    expect(c.track.reaction.mock.calls[0][0]).toMatchObject({
      type: 'Image_Delete',
      ownerId: OWNER,
    });
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  });

  it('ON: both image reads through Kysely on the replica, with the same outcome', async () => {
    flag.mockResolvedValue(true);
    q.getImagePostId.mockResolvedValue({ postId: POST } as never);
    q.getImageNsfwLevelAndOwner.mockResolvedValue({ nsfwLevel: 4, userId: OWNER } as never);
    const c = ctx() as { track: { reaction: ReturnType<typeof vi.fn> } };
    await toggleReactionHandler({ ctx: c as never, input });

    expect(q.getImagePostId.mock.calls).toEqual([[kyselyRead, IMAGE]]);
    expect(q.getImagePostId.mock.calls[0][0]).toBe(kyselyRead);
    expect(q.getImageNsfwLevelAndOwner.mock.calls).toEqual([[kyselyRead, IMAGE]]);
    expect(q.getImageNsfwLevelAndOwner.mock.calls[0][0]).toBe(kyselyRead);
    expect(hasEntityAccess.mock.calls[0][0].entityIds).toEqual([POST]);
    expect(c.track.reaction.mock.calls[0][0]).toMatchObject({
      type: 'Image_Delete',
      ownerId: OWNER,
    });
    expect(dbMock.dbRead.image.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(dbMock.dbRead.image.findFirst).not.toHaveBeenCalled();
  });

  it('ON: an image in no post skips the access check, as Prisma did', async () => {
    flag.mockResolvedValue(true);
    q.getImagePostId.mockResolvedValue({ postId: null } as never);
    await toggleReactionHandler({ ctx: ctx(), input });
    expect(hasEntityAccess).not.toHaveBeenCalled();
    expect(dbMock.dbRead.image.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('ON: a missing image runs the Prisma read, so its error is the one it always was', async () => {
    flag.mockResolvedValue(true);
    q.getImagePostId.mockResolvedValue(undefined as never);
    const notFound = new Error('No Image found');
    dbMock.dbRead.image.findUniqueOrThrow.mockRejectedValue(notFound);
    await expect(toggleReactionHandler({ ctx: ctx(), input })).rejects.toThrow();
    expect(dbMock.dbRead.image.findUniqueOrThrow.mock.calls).toEqual([[{ where: { id: IMAGE } }]]);
    expect(toggleReaction).not.toHaveBeenCalled();
  });
});
