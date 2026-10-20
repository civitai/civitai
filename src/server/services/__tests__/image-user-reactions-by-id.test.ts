import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Capture from '~/server/services/feed-request-capture.service';
import type * as FliptClient from '~/server/flipt/client';
import type * as ImageDbQueries from '@civitai/db-queries/image';

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/feed-request-capture.service', async (importOriginal) => {
  const actual = await importOriginal<typeof Capture>();
  return { ...actual, feedRequestCapture: () => ({ record: async () => undefined }) };
});

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real so the flag key asserted below is the
// one production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Only the reactions read is stubbed; its SQL is pinned in
// packages/civitai-db-queries/src/image.db.test.ts and its rows against Prisma's in
// src/server/db/__tests__/kysely-prisma-parity.test.ts.
vi.mock('@civitai/db-queries/image', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageDbQueries>()),
  listImageReactionsMany: vi.fn(),
}));

import { listImageReactionsMany } from '@civitai/db-queries/image';
import { getUserReactionsForImages } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';

const kyselyReactions = vi.mocked(listImageReactionsMany);
const flag = vi.mocked(isFlipt);

const VIEWER = 9266475;

describe('getUserReactionsForImages', () => {
  beforeEach(() => {
    dbMock.dbRead.imageReaction.findMany.mockReset();
    dbMock.dbRead.imageReaction.findMany.mockResolvedValue([]);
    kyselyReactions.mockReset().mockResolvedValue([]);
    flag.mockReset().mockResolvedValue(false);
  });

  it('groups the viewer reactions by image', async () => {
    dbMock.dbRead.imageReaction.findMany.mockResolvedValue([
      { imageId: 142799705, reaction: 'Like' },
      { imageId: 142799705, reaction: 'Heart' },
      { imageId: 2, reaction: 'Cry' },
    ]);

    await expect(
      getUserReactionsForImages({ imageIds: [142799705, 2], userId: VIEWER })
    ).resolves.toEqual({ 142799705: ['Like', 'Heart'], 2: ['Cry'] });
  });

  it('asks only for the viewer own rows', async () => {
    await getUserReactionsForImages({ imageIds: [1, 2], userId: VIEWER });

    // Dropping `userId` here returns every viewer's reactions, and the merge credits all of them
    // to the current one — so every image on the front page would draw as already reacted, and
    // the first click on any of them would create a reaction rather than the removal it looks
    // like. That is the inverse of the bug this function exists to fix.
    expect(dbMock.dbRead.imageReaction.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.imageReaction.findMany).toHaveBeenCalledWith({
      where: { imageId: { in: [1, 2] }, userId: VIEWER },
      select: { imageId: true, reaction: true },
    });
  });

  it('does not query at all for an empty set of ids', async () => {
    await expect(getUserReactionsForImages({ imageIds: [], userId: VIEWER })).resolves.toEqual({});

    expect(dbMock.dbRead.imageReaction.findMany).not.toHaveBeenCalled();
    expect(kyselyReactions).not.toHaveBeenCalled();
    expect(flag).not.toHaveBeenCalled();
  });

  describe('kysely-image-reactions flag', () => {
    const ROWS = [
      { imageId: 142799705, reaction: 'Like' as const },
      { imageId: 142799705, reaction: 'Heart' as const },
      { imageId: 2, reaction: 'Cry' as const },
    ];

    it('evaluates the flag once per call, by key, with no entity or context', async () => {
      await getUserReactionsForImages({ imageIds: [1, 2, 3], userId: VIEWER });
      expect(flag).toHaveBeenCalledTimes(1);
      // No entityId: the flag is a global boolean. Passing the user id would split the eval cache
      // per viewer on a hot path and make a rollout read as a per-user percentage it is not.
      expect(flag).toHaveBeenCalledWith(FLIPT_FEATURE_FLAGS.KYSELY_IMAGE_REACTIONS);
      expect(FLIPT_FEATURE_FLAGS.KYSELY_IMAGE_REACTIONS).toBe('kysely-image-reactions');
    });

    it('OFF: reads through Prisma only', async () => {
      flag.mockResolvedValue(false);
      dbMock.dbRead.imageReaction.findMany.mockResolvedValue(ROWS);

      await expect(
        getUserReactionsForImages({ imageIds: [142799705, 2], userId: VIEWER })
      ).resolves.toEqual({ 142799705: ['Like', 'Heart'], 2: ['Cry'] });
      expect(dbMock.dbRead.imageReaction.findMany).toHaveBeenCalledTimes(1);
      expect(kyselyReactions).not.toHaveBeenCalled();
    });

    it('ON: reads through Kysely on the read replica only, with the same ids and viewer', async () => {
      flag.mockResolvedValue(true);
      kyselyReactions.mockResolvedValue(ROWS);

      await expect(
        getUserReactionsForImages({ imageIds: [142799705, 2], userId: VIEWER })
      ).resolves.toEqual({ 142799705: ['Like', 'Heart'], 2: ['Cry'] });
      expect(kyselyReactions).toHaveBeenCalledTimes(1);
      // `toBe`: kyselyRead and kyselyWrite are distinct clients; the Prisma path reads dbRead, so
      // the Kysely path must read the replica too, not the primary.
      expect(kyselyReactions.mock.calls[0][0]).toBe(kyselyRead);
      // Control for the identity check above: it only separates read from write while they differ.
      expect(kyselyRead).not.toBe(kyselyWrite);
      expect(kyselyReactions.mock.calls[0][1]).toEqual({
        imageIds: [142799705, 2],
        userId: VIEWER,
      });
      expect(dbMock.dbRead.imageReaction.findMany).not.toHaveBeenCalled();
    });
  });
});
