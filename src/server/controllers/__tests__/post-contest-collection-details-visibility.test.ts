import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { CollectionMode, CollectionType } from '~/shared/utils/prisma/enums';

/**
 * `post.getContestCollectionDetails` reads by post id, so it answers only when `post.get` would,
 * and a post the viewer may not open answers as a missing one does. Within a visible post, only
 * the entries of images the viewer may open are listed, and permissions are the viewer's own.
 * `getPostDetail` and `getImageIdsVisibleToViewer` are stubbed with their contracts.
 */

const m = vi.hoisted(() => ({
  getPostDetail: vi.fn(),
  amIBlockedByUser: vi.fn(),
  visibleIds: vi.fn(),
  getCollectionById: vi.fn(),
  permissions: vi.fn(),
}));

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPostDetail: m.getPostDetail,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  amIBlockedByUser: m.amIBlockedByUser,
}));
vi.mock('~/server/services/image-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getImageIdsVisibleToViewer: m.visibleIds,
}));
// No importOriginal: collection.service and post.service import each other, and spreading the
// original here hands post.service the unmocked module.
vi.mock('~/server/services/collection.service', () => ({
  getCollectionById: m.getCollectionById,
  getUserCollectionPermissionsById: m.permissions,
}));

import { getPostContestCollectionDetailsHandler } from '~/server/controllers/post.controller';

const POST_ID = 9;
const OWNER = 5;
const COLLECTION_ID = 40;
const SHOWN = 101;
const HIDDEN = 102;
const MISSING = { collection: null, permissions: null, items: [] };
const COLLECTION_OWNER = 600;
// May add to the collection without reading it (Private read, write granted).
const WRITER = 601;
let collectionPrivate = false;

type User = { id: number; isModerator?: boolean } | undefined;
const ANON: User = undefined;
const STRANGER: User = { id: 77 };
const SELF: User = { id: OWNER };
const MOD: User = { id: 78, isModerator: true };

function postIs({ published = true }: { published?: boolean }) {
  m.getPostDetail.mockImplementation(async ({ id, user }: { id: number; user?: User }) => {
    const visible = published || user?.id === OWNER || user?.isModerator === true;
    if (id !== POST_ID || !visible) throw new TRPCError({ code: 'NOT_FOUND' });
    return { id, user: { id: OWNER } };
  });
}

const detailsFor = (user: User) =>
  getPostContestCollectionDetailsHandler({ input: { id: POST_ID }, ctx: { user } as never });
const itemImageIds = (result: Awaited<ReturnType<typeof detailsFor>>) =>
  result.items.map((item) => item.imageId);

beforeEach(() => {
  vi.clearAllMocks();
  m.amIBlockedByUser.mockResolvedValue(false);
  m.getCollectionById.mockResolvedValue({
    id: COLLECTION_ID,
    mode: CollectionMode.Contest,
    type: CollectionType.Image,
  });
  collectionPrivate = false;
  // getUserCollectionPermissionsById's rule, reduced: a Private collection is read only by its
  // owner and moderators.
  m.permissions.mockImplementation(
    async ({ userId, isModerator }: { userId?: number; isModerator?: boolean }) => {
      const manage = userId === COLLECTION_OWNER || !!isModerator;
      const write = userId === WRITER;
      return { userId, read: !collectionPrivate || manage, write, manage };
    }
  );
  m.visibleIds.mockImplementation(async ({ ids, userId, isModerator }) => {
    const opens = isModerator || userId === OWNER;
    return new Set((ids as number[]).filter((id) => id !== HIDDEN || opens));
  });
  dbMock.dbRead.post.findUnique.mockResolvedValue({
    collectionId: COLLECTION_ID,
    userId: OWNER,
  } as never);
  dbMock.dbRead.image.findMany.mockResolvedValue([{ id: SHOWN }, { id: HIDDEN }] as never);
  dbMock.dbRead.collectionItem.findMany.mockImplementation((async (args: {
    where: { imageId: { in: number[] } };
  }) =>
    args.where.imageId.in.map((imageId) => ({
      id: imageId * 10,
      imageId,
      postId: null,
    }))) as never);
});

describe('post.getContestCollectionDetails visibility', () => {
  it('answers an unpublished post as a missing one for a stranger and signed out', async () => {
    postIs({ published: false });
    expect(await detailsFor(STRANGER)).toEqual(MISSING);
    expect(await detailsFor(ANON)).toEqual(MISSING);
    expect(dbMock.dbRead.collectionItem.findMany).not.toHaveBeenCalled();
  });

  it('answers a post whose owner blocked the viewer as a missing one', async () => {
    postIs({});
    m.amIBlockedByUser.mockResolvedValue(true);
    expect(await detailsFor(STRANGER)).toEqual(MISSING);
  });

  it('lists only the entries of images the viewer may open', async () => {
    postIs({});
    expect(itemImageIds(await detailsFor(STRANGER))).toEqual([SHOWN]);
    expect(itemImageIds(await detailsFor(ANON))).toEqual([SHOWN]);
  });

  it('serves every entry of an unpublished post to its owner and a moderator', async () => {
    postIs({ published: false });
    expect(itemImageIds(await detailsFor(SELF))).toEqual([SHOWN, HIDDEN]);
    expect(itemImageIds(await detailsFor(MOD))).toEqual([SHOWN, HIDDEN]);
  });

  it('computes permissions for the signed-in viewer, not as signed out', async () => {
    postIs({});
    expect((await detailsFor(STRANGER)).permissions).toMatchObject({ userId: STRANGER!.id });
  });

  it('answers a Private collection as none for a viewer who may not read it', async () => {
    postIs({});
    collectionPrivate = true;
    // WRITER may add to it but not read it.
    for (const user of [ANON, STRANGER, { id: WRITER }])
      expect(await detailsFor(user)).toEqual(MISSING);
    expect(m.getCollectionById).not.toHaveBeenCalled();
    expect(dbMock.dbRead.collectionItem.findMany).not.toHaveBeenCalled();
  });

  it("serves a Private collection's entries to its owner, a moderator and the post's owner", async () => {
    postIs({});
    collectionPrivate = true;
    for (const user of [{ id: COLLECTION_OWNER }, MOD, SELF]) {
      expect(itemImageIds(await detailsFor(user)).length).toBeGreaterThan(0);
      expect(m.getCollectionById).toHaveBeenLastCalledWith(
        expect.objectContaining({ viewer: { id: user.id, isModerator: user.isModerator } })
      );
    }
  });

  it('reads the collection as signed out, with no viewer, for a signed-out caller', async () => {
    postIs({});
    await detailsFor(ANON);
    expect(m.getCollectionById).toHaveBeenLastCalledWith(
      expect.objectContaining({ viewer: undefined })
    );
  });

  it('gives a moderator their moderator permissions', async () => {
    postIs({});
    expect((await detailsFor(MOD)).permissions).toMatchObject({ manage: true });
  });
});
