import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `image.getContestCollectionDetails` is public. An image the viewer may not open by id must get
 * the answer an id with no contest entries gets — `{ collectionItems: [], post: null }` — with
 * neither the entries nor the post's title and detail read. The visibility rule itself is pinned
 * by `assertImageVisibleToViewer`'s own tests; this file pins that the handler applies it.
 */
const mocks = vi.hoisted(() => ({
  assertImageVisibleToViewer: vi.fn(),
  getImageContestCollectionDetails: vi.fn(),
  getPostDetailByImageId: vi.fn(),
}));

vi.mock('~/server/services/image-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertImageVisibleToViewer: mocks.assertImageVisibleToViewer,
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getImageContestCollectionDetails: mocks.getImageContestCollectionDetails,
  getPostDetailByImageId: mocks.getPostDetailByImageId,
}));

const { getImageContestCollectionDetailsHandler } = await import(
  '~/server/controllers/image.controller'
);

type HandlerCtx = Parameters<typeof getImageContestCollectionDetailsHandler>[0]['ctx'];

const IMAGE_ID = 5150;
const VIEWER = { id: 77, isModerator: false };
const ITEMS = [{ id: 1, imageId: IMAGE_ID, collection: { id: 10 } }];
const POST = { title: 'Entry title', detail: 'Entry detail' };

const ctx = (user: unknown) => ({ user } as unknown as HandlerCtx);
const notFound = () => new TRPCError({ code: 'NOT_FOUND', message: 'not found' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getImageContestCollectionDetails.mockResolvedValue(ITEMS);
  mocks.getPostDetailByImageId.mockResolvedValue(POST);
});

describe('getImageContestCollectionDetailsHandler', () => {
  it('a hidden image answers exactly like an id with no contest entries', async () => {
    mocks.assertImageVisibleToViewer.mockRejectedValue(notFound());
    const hidden = await getImageContestCollectionDetailsHandler({
      input: { id: IMAGE_ID },
      ctx: ctx(VIEWER),
    });

    mocks.assertImageVisibleToViewer.mockResolvedValue({ id: IMAGE_ID });
    mocks.getImageContestCollectionDetails.mockResolvedValue([]);
    const noEntries = await getImageContestCollectionDetailsHandler({
      input: { id: IMAGE_ID },
      ctx: ctx(VIEWER),
    });

    expect(hidden).toEqual({ collectionItems: [], post: null });
    expect(hidden).toEqual(noEntries);
    expect(mocks.getPostDetailByImageId).not.toHaveBeenCalled();
  });

  it('a hidden image reads neither its entries nor its post', async () => {
    mocks.assertImageVisibleToViewer.mockRejectedValue(notFound());
    await getImageContestCollectionDetailsHandler({ input: { id: IMAGE_ID }, ctx: ctx(null) });
    expect(mocks.getImageContestCollectionDetails).not.toHaveBeenCalled();
    expect(mocks.getPostDetailByImageId).not.toHaveBeenCalled();
  });

  it('control: a visible image returns its entries and post', async () => {
    mocks.assertImageVisibleToViewer.mockResolvedValue({ id: IMAGE_ID });
    const result = await getImageContestCollectionDetailsHandler({
      input: { id: IMAGE_ID },
      ctx: ctx(VIEWER),
    });
    expect(result).toEqual({ collectionItems: ITEMS, post: POST });
  });

  it("passes the image's owner to the entry read", async () => {
    mocks.assertImageVisibleToViewer.mockResolvedValue({ id: IMAGE_ID, userId: 321 });
    await getImageContestCollectionDetailsHandler({ input: { id: IMAGE_ID }, ctx: ctx(VIEWER) });
    expect(mocks.getImageContestCollectionDetails).toHaveBeenCalledWith(
      expect.objectContaining({ id: IMAGE_ID, imageOwnerId: 321 })
    );
  });

  it('checks visibility as the requesting viewer', async () => {
    mocks.assertImageVisibleToViewer.mockResolvedValue({ id: IMAGE_ID });
    await getImageContestCollectionDetailsHandler({
      input: { id: IMAGE_ID },
      ctx: ctx({ id: 900, isModerator: true }),
    });
    expect(mocks.assertImageVisibleToViewer).toHaveBeenCalledWith({
      id: IMAGE_ID,
      userId: 900,
      isModerator: true,
    });
  });

  it('an error other than not-found is not swallowed into an empty answer', async () => {
    mocks.assertImageVisibleToViewer.mockRejectedValue(
      new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'db down' })
    );
    await expect(
      getImageContestCollectionDetailsHandler({ input: { id: IMAGE_ID }, ctx: ctx(VIEWER) })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});
