import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type { SessionUser } from '~/types/session';

const { reorderPostImages, shiftsPinnedRank } = await import('~/server/services/post.service');
const { imageOnlyReorderIndexes } = await import('~/components/Post/EditV2/post-edit-items');

const w = dbMock.dbWrite;
const POST = 5;
// The post's owner on an uncapped request: the editor shows every image.
const EDITOR = { user: { id: 1 } as SessionUser, servableLevels: allBrowsingLevelsFlag };

const imageIndexes = () =>
  w.image.update.mock.calls.map(([call]) => [call.where.id, call.data.index]);
const textIndexes = () =>
  w.postText.update.mock.calls.map(([call]) => [call.where.id, call.data.index]);

describe('reorderPostImages with storyline text items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    w.$transaction.mockResolvedValue([] as never);
    // No image hidden from the editor, and no text left out, unless a test says so.
    w.image.findMany.mockResolvedValue([] as never);
    w.postText.findMany.mockResolvedValue([] as never);
  });

  it('writes the position of every item, images and text, when given `items`', async () => {
    await reorderPostImages({
      ...EDITOR,
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
    w.image.findMany.mockResolvedValue([
      { id: 10, index: 0, needsReview: null, nsfwLevel: 1 },
      { id: 11, index: 1, needsReview: null, nsfwLevel: 1 },
      { id: 12, index: 3, needsReview: null, nsfwLevel: 1 },
    ] as never);
    await reorderPostImages({ ...EDITOR, id: POST, imageIds: [12, 11, 10] });
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
    w.image.findMany.mockResolvedValue(
      reordered.map(({ id, index }) => ({ id, index, needsReview: null, nsfwLevel: 1 })) as never
    );
    await reorderPostImages({ ...EDITOR, id: POST, imageIds: reordered.map((image) => image.id) });
    const predicted = imageOnlyReorderIndexes(reordered, true);
    expect(imageIndexes()).toEqual(reordered.map((image, i) => [image.id, predicted[i]]));
    expect(textIndexes()).toEqual([]);

    vi.clearAllMocks();
    w.$transaction.mockResolvedValue([] as never);
    w.image.findMany.mockResolvedValue([] as never);
    w.postText.count.mockResolvedValue(0 as never);
    await reorderPostImages({ ...EDITOR, id: POST, imageIds: [12, 10] });
    expect(imageIndexes().map(([, index]) => index)).toEqual(
      imageOnlyReorderIndexes(reordered.slice(0, 2), false)
    );
  });

  it('without `items` on a post with no text, writes positions as before', async () => {
    w.postText.count.mockResolvedValue(0 as never);
    await reorderPostImages({ ...EDITOR, id: POST, imageIds: [12, 11] });
    expect(imageIndexes()).toEqual([
      [12, 0],
      [11, 1],
    ]);
  });
});

describe('shiftsPinnedRank', () => {
  // Rated A at 0, pinned held P at 1, unrated U at 2: one counted image is ahead of P.
  const images = [
    { id: 1, index: 0, nsfwLevel: 1, pinned: false },
    { id: 2, index: 1, nsfwLevel: 1, pinned: true },
    { id: 3, index: 2, nsfwLevel: 0, pinned: false },
  ];

  it('flags a write that moves a counted image past a pinned one', () => {
    expect(
      shiftsPinnedRank(images, [
        { type: 'image', id: 3, index: 0 },
        { type: 'image', id: 1, index: 2 },
      ])
    ).toBe(true);
  });

  it("control: passes a write that keeps every pinned image's count ahead of it", () => {
    expect(
      shiftsPinnedRank(images, [
        { type: 'image', id: 1, index: 0 },
        { type: 'image', id: 3, index: 2 },
        { type: 'text', id: 9, index: 3 },
      ])
    ).toBe(false);
  });

  it('reads a null index as last, as the version level sorts it', () => {
    // Rated M has no index, so it ranks after pinned P at 2; writing it at 0 moves it ahead of P.
    const withNull = [
      { id: 1, index: null, nsfwLevel: 1, pinned: false },
      { id: 2, index: 2, nsfwLevel: 1, pinned: true },
    ];
    expect(shiftsPinnedRank(withNull, [{ type: 'image', id: 1, index: 0 }])).toBe(true);
    expect(shiftsPinnedRank(withNull, [{ type: 'image', id: 1, index: 3 }])).toBe(false);
  });

  it('flags moving an unrated image past a pinned one: it counts once its scan rates it', () => {
    // Unrated U at 0, pinned P at 1. Today nothing counts ahead of P either way; once U is rated, it would.
    const unrated = [
      { id: 1, index: 0, nsfwLevel: 0, pinned: false },
      { id: 2, index: 1, nsfwLevel: 1, pinned: true },
    ];
    expect(shiftsPinnedRank(unrated, [{ type: 'image', id: 1, index: 2 }])).toBe(true);
  });

  it('flags moving a Blocked image past a pinned one: a lifted verdict makes it count', () => {
    const blocked = [
      { id: 1, index: 0, nsfwLevel: 32, pinned: false },
      { id: 2, index: 1, nsfwLevel: 1, pinned: true },
    ];
    expect(shiftsPinnedRank(blocked, [{ type: 'image', id: 1, index: 2 }])).toBe(true);
    expect(shiftsPinnedRank(blocked, [{ type: 'image', id: 1, index: 0 }])).toBe(false);
  });
});
