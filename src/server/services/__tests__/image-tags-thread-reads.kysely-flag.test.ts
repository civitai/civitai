import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads from '@civitai/db-queries/hot-reads';

// Mocked for the invariant guard that no flag check remains on these reads (not regression coverage).
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read query stubbed: their rows, against a real database, are pinned in
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
    q.listImageTagsForImages.mockResolvedValue([tagRow] as never);
  });

  it('control: the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });

  it('reads Kysely only, the replica unless the refresh came from a write (invariant: no flag check remains)', async () => {
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
    expect(flag, 'invariant: no flag check remains').not.toHaveBeenCalled();
  });
});

describe('getCommentsThreadDetails2 (an image thread)', () => {
  const imageThread = () => getCommentsThreadDetails2({ entityType: 'image', entityId: IMAGE });

  it('reads the thread through Kysely only, on the replica (invariant: no flag check remains)', async () => {
    q.getImageThread.mockResolvedValue({ id: THREAD, locked: true } as never);
    await expect(imageThread()).resolves.toEqual({ id: THREAD, locked: true });
    expect(q.getImageThread.mock.calls).toEqual([[kyselyRead, IMAGE]]);
    expect(q.getImageThread.mock.calls[0][0]).toBe(kyselyRead);
    expect(flag, 'invariant: no flag check remains').not.toHaveBeenCalled();
    expect(dbMock.dbRead.thread.findUnique).not.toHaveBeenCalled();
  });

  it('no thread is null, as findUnique returned', async () => {
    q.getImageThread.mockResolvedValue(undefined);
    await expect(imageThread()).resolves.toBeNull();
    expect(dbMock.dbRead.thread.findUnique).not.toHaveBeenCalled();
  });

  it('any other entity type stays on Prisma', async () => {
    dbMock.dbRead.thread.findUnique.mockResolvedValue({ id: THREAD, locked: false });
    await expect(
      getCommentsThreadDetails2({ entityType: 'model', entityId: MODEL })
    ).resolves.toEqual({ id: THREAD, locked: false });
    expect(dbMock.dbRead.thread.findUnique).toHaveBeenCalledWith({
      where: { modelId: MODEL },
      select: { id: true, locked: true },
    });
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  });
});

describe('getCommentsInfinite (the main-thread lookup of an image)', () => {
  // No thread ends the read right after the lookup, so these pin the lookup alone.
  const imageComments = () => getCommentsInfinite({ entityType: 'image', entityId: IMAGE });

  it('looks the thread up through Kysely only, on the replica', async () => {
    q.getImageThread.mockResolvedValue(undefined);
    await expect(imageComments()).resolves.toBeNull();
    expect(q.getImageThread.mock.calls).toEqual([[kyselyRead, IMAGE]]);
    expect(dbMock.dbRead.thread.findUnique).not.toHaveBeenCalled();
  });

  it('the found thread id is what the comment reads use', async () => {
    q.getImageThread.mockResolvedValue({ id: THREAD, locked: false } as never);
    dbMock.dbRead.commentV2.findMany.mockRejectedValue(new Error('reached the comment read'));
    await expect(imageComments()).rejects.toThrow('reached the comment read');
    expect(dbMock.dbRead.commentV2.findMany.mock.calls[0][0].where.threadId).toBe(THREAD);
    expect(dbMock.dbRead.thread.findUnique).not.toHaveBeenCalled();
  });

  it('a model thread is looked up through Prisma', async () => {
    dbMock.dbRead.thread.findUnique.mockResolvedValue(null);
    await expect(getCommentsInfinite({ entityType: 'model', entityId: MODEL })).resolves.toBeNull();
    expect(dbMock.dbRead.thread.findUnique).toHaveBeenCalledWith({
      where: { modelId: MODEL },
      select: { id: true },
    });
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  });
});
