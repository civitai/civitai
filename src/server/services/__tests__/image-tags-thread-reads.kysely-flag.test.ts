import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads from '@civitai/db-queries/hot-reads';

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one
// production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read query stubbed: their rows against Prisma's are compared in
// hot-reads-2.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});

import * as queries from '@civitai/db-queries/hot-reads';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';
import { readImageTagsForImages } from '~/server/redis/caches';
import {
  getCommentsInfinite,
  getCommentsThreadDetails2,
} from '~/server/services/commentsv2.service';

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);

// Pairwise distinct.
const IMAGE = 9401;
const OTHER_IMAGE = 9402;
const THREAD = 9503;
const MODEL = 9604;

const tagRow = {
  imageId: IMAGE,
  tagId: 9705,
  tagName: 'cat',
  tagType: 'Label',
  score: 12,
  upVotes: 3,
  downVotes: 1,
  tagNsfwLevel: 1,
  automated: true,
  needsReview: false,
  concrete: true,
  lastUpvote: new Date('2026-10-03T04:05:06.789Z'),
  source: 'WD14',
};

const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
});

describe('readImageTagsForImages (imageTagsCache)', () => {
  beforeEach(() => {
    dbMock.dbRead.imageTag.findMany.mockResolvedValue([tagRow]);
    dbMock.dbWrite.imageTag.findMany.mockResolvedValue([tagRow]);
    q.listImageTagsForImages.mockResolvedValue([tagRow] as never);
  });

  it('control: the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });

  it('evaluates kysely-hot-reads-2 by key, with no entity or context', async () => {
    await readImageTagsForImages([IMAGE]);
    expect(flag.mock.calls).toEqual([['kysely-hot-reads-2']]);
  });

  it('OFF: reads Prisma only, the replica unless the refresh came from a write', async () => {
    await expect(readImageTagsForImages([IMAGE, OTHER_IMAGE])).resolves.toEqual([tagRow]);
    expect(dbMock.dbRead.imageTag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { imageId: { in: [IMAGE, OTHER_IMAGE] } },
        orderBy: [{ score: 'desc' }, { tagId: 'asc' }],
      })
    );
    await readImageTagsForImages([IMAGE], true);
    expect(dbMock.dbWrite.imageTag.findMany).toHaveBeenCalledTimes(1);
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  });

  it('ON: reads Kysely only, on the same database', async () => {
    flag.mockResolvedValue(true);
    await expect(readImageTagsForImages([IMAGE, OTHER_IMAGE])).resolves.toEqual([tagRow]);
    await readImageTagsForImages([IMAGE], true);
    expect(q.listImageTagsForImages.mock.calls).toEqual([
      [kyselyRead, [IMAGE, OTHER_IMAGE]],
      [kyselyWrite, [IMAGE]],
    ]);
    expect(q.listImageTagsForImages.mock.calls[0][0]).toBe(kyselyRead);
    expect(q.listImageTagsForImages.mock.calls[1][0]).toBe(kyselyWrite);
    expect(dbMock.dbRead.imageTag.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.imageTag.findMany).not.toHaveBeenCalled();
  });
});

describe('getCommentsThreadDetails2 (an image thread)', () => {
  const imageThread = () => getCommentsThreadDetails2({ entityType: 'image', entityId: IMAGE });

  it('OFF: reads Prisma only', async () => {
    dbMock.dbRead.thread.findUnique.mockResolvedValue({ id: THREAD, locked: true });
    await expect(imageThread()).resolves.toEqual({ id: THREAD, locked: true });
    expect(dbMock.dbRead.thread.findUnique).toHaveBeenCalledWith({
      where: { imageId: IMAGE },
      select: { id: true, locked: true },
    });
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  });

  it('ON: reads the same thread through Kysely only, on the replica', async () => {
    flag.mockResolvedValue(true);
    q.getImageThread.mockResolvedValue({ id: THREAD, locked: true } as never);
    await expect(imageThread()).resolves.toEqual({ id: THREAD, locked: true });
    expect(q.getImageThread.mock.calls).toEqual([[kyselyRead, IMAGE]]);
    expect(q.getImageThread.mock.calls[0][0]).toBe(kyselyRead);
    expect(flag.mock.calls).toEqual([['kysely-hot-reads-2']]);
    expect(dbMock.dbRead.thread.findUnique).not.toHaveBeenCalled();
  });

  it('ON: no thread is null, as findUnique returns', async () => {
    flag.mockResolvedValue(true);
    q.getImageThread.mockResolvedValue(undefined);
    await expect(imageThread()).resolves.toBeNull();
    expect(dbMock.dbRead.thread.findUnique).not.toHaveBeenCalled();
  });

  it('ON: any other entity type stays on Prisma, without evaluating the flag', async () => {
    flag.mockResolvedValue(true);
    dbMock.dbRead.thread.findUnique.mockResolvedValue({ id: THREAD, locked: false });
    await getCommentsThreadDetails2({ entityType: 'model', entityId: MODEL });
    expect(dbMock.dbRead.thread.findUnique).toHaveBeenCalledWith({
      where: { modelId: MODEL },
      select: { id: true, locked: true },
    });
    expect(flag).not.toHaveBeenCalled();
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  });
});

describe('getCommentsInfinite (the main-thread lookup of an image)', () => {
  // No thread ends the read right after the lookup, so these pin the lookup alone.
  const imageComments = () => getCommentsInfinite({ entityType: 'image', entityId: IMAGE });

  it('OFF: looks the thread up through Prisma only', async () => {
    dbMock.dbRead.thread.findUnique.mockResolvedValue(null);
    await expect(imageComments()).resolves.toBeNull();
    expect(dbMock.dbRead.thread.findUnique).toHaveBeenCalledWith({
      where: { imageId: IMAGE },
      select: { id: true },
    });
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  });

  it('ON: looks it up through Kysely only, on the replica', async () => {
    flag.mockResolvedValue(true);
    q.getImageThread.mockResolvedValue(undefined);
    await expect(imageComments()).resolves.toBeNull();
    expect(q.getImageThread.mock.calls).toEqual([[kyselyRead, IMAGE]]);
    expect(dbMock.dbRead.thread.findUnique).not.toHaveBeenCalled();
  });

  it('ON: the found thread id is what the comment reads use', async () => {
    flag.mockResolvedValue(true);
    q.getImageThread.mockResolvedValue({ id: THREAD, locked: false } as never);
    dbMock.dbRead.commentV2.findMany.mockRejectedValue(new Error('reached the comment read'));
    await expect(imageComments()).rejects.toThrow('reached the comment read');
    expect(dbMock.dbRead.commentV2.findMany.mock.calls[0][0].where.threadId).toBe(THREAD);
    expect(dbMock.dbRead.thread.findUnique).not.toHaveBeenCalled();
  });
});
