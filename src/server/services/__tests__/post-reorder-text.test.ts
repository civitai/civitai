import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { reorderPostImages } = await import('~/server/services/post.service');
const { imageOnlyReorderIndexes } = await import('~/components/Post/EditV2/post-edit-items');

const w = dbMock.dbWrite;
const POST = 5;

const imageIndexes = () =>
  w.image.update.mock.calls.map(([call]) => [call.where.id, call.data.index]);
const textIndexes = () =>
  w.postText.update.mock.calls.map(([call]) => [call.where.id, call.data.index]);

describe('reorderPostImages with storyline text items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    w.$transaction.mockResolvedValue([] as never);
  });

  it('writes the position of every item, images and text, when given `items`', async () => {
    await reorderPostImages({
      id: POST,
      imageIds: [],
      items: [
        { type: 'image', id: 11 },
        { type: 'text', id: 1 },
        { type: 'image', id: 10 },
      ],
    });
    expect(imageIndexes()).toEqual([
      [11, 0],
      [10, 2],
    ]);
    expect(textIndexes()).toEqual([[1, 1]]);
    // Each write is scoped to the post, so ids from another post change nothing.
    for (const [call] of [...w.image.update.mock.calls, ...w.postText.update.mock.calls])
      expect(call.where).toEqual({ id: call.where.id, postId: POST });
  });

  it('without `items`, keeps every text row where it is: images swap the indexes they hold', async () => {
    // Images at 0, 1 and 3, a text at 2. An old editor sends the images reversed.
    w.postText.count.mockResolvedValue(1 as never);
    w.image.findMany.mockResolvedValue([{ index: 3 }, { index: 0 }, { index: 1 }] as never);
    await reorderPostImages({ id: POST, imageIds: [12, 11, 10] });
    expect(imageIndexes()).toEqual([
      [12, 0],
      [11, 1],
      [10, 3],
    ]);
    expect(textIndexes()).toEqual([]);
  });

  it("the editor's image-only reorder predicts the indexes the server writes, texts untouched", async () => {
    // Images 10 (0), 11 (1) and 12 (3) around a text at 2; the editor drags 12 to the front.
    const reordered = [
      { id: 12, index: 3 },
      { id: 10, index: 0 },
      { id: 11, index: 1 },
    ];
    w.postText.count.mockResolvedValue(1 as never);
    w.image.findMany.mockResolvedValue(reordered.map(({ index }) => ({ index })) as never);
    await reorderPostImages({ id: POST, imageIds: reordered.map((image) => image.id) });
    const predicted = imageOnlyReorderIndexes(reordered, true);
    expect(imageIndexes()).toEqual(reordered.map((image, i) => [image.id, predicted[i]]));
    expect(textIndexes()).toEqual([]);

    vi.clearAllMocks();
    w.$transaction.mockResolvedValue([] as never);
    w.postText.count.mockResolvedValue(0 as never);
    await reorderPostImages({ id: POST, imageIds: [12, 10] });
    expect(imageIndexes().map(([, index]) => index)).toEqual(
      imageOnlyReorderIndexes(reordered.slice(0, 2), false)
    );
  });

  it('without `items` on a post with no text, writes positions as before', async () => {
    w.postText.count.mockResolvedValue(0 as never);
    await reorderPostImages({ id: POST, imageIds: [12, 11] });
    expect(imageIndexes()).toEqual([
      [12, 0],
      [11, 1],
    ]);
  });
});
