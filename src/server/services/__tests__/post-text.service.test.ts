import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as NsfwLevels from '~/server/services/nsfwLevels.service';
import type * as Submit from '~/server/services/text-scan/submit';

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof Submit>()),
  scanEntityInBackground: vi.fn(),
}));
vi.mock('~/server/services/nsfwLevels.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NsfwLevels>()),
  updatePostNsfwLevels: vi.fn(async () => []),
}));

const { addPostText, setPostText, deletePostText, getPostTextsForViewer, getStorylineTextStubs } =
  await import('~/server/services/post-text.service');
const { throwOnBlockedUserContent } = await import('~/server/services/blocklist.service');
const { scanEntityInBackground } = await import('~/server/services/text-scan/submit');
const { updatePostNsfwLevels } = await import('~/server/services/nsfwLevels.service');

const w = dbMock.dbWrite;
const r = dbMock.dbRead;
const AUTHOR = 7;
const POST = 5;
const TEXT = 31;

const stored = (content = '<p>old</p>', csamHeld = false) =>
  w.postText.findUnique.mockResolvedValue({
    id: TEXT,
    postId: POST,
    content,
    csamHeld,
    post: { userId: AUTHOR },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  w.post.findUnique.mockResolvedValue({ userId: AUTHOR } as never);
  w.storylineChapter.findFirst.mockResolvedValue({ id: 9 } as never);
  w.storylinePendingChapter.findUnique.mockResolvedValue(null as never);
  w.postText.count.mockResolvedValue(0 as never);
  w.postText.create.mockResolvedValue({ id: TEXT } as never);
  stored();
});

describe('addPostText', () => {
  it("adds an empty text at the index it is given, on the author's chapter post", async () => {
    await addPostText({ postId: POST, index: 3, userId: AUTHOR });
    expect(w.postText.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { postId: POST, userId: AUTHOR, index: 3, content: '' } })
    );
  });

  it('refuses anyone but the author, a post that is no chapter, and a 21st text', async () => {
    await expect(addPostText({ postId: POST, index: 3, userId: 99 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    w.storylineChapter.findFirst.mockResolvedValueOnce(null as never);
    await expect(addPostText({ postId: POST, index: 3, userId: AUTHOR })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    w.postText.count.mockResolvedValueOnce(20 as never);
    await expect(addPostText({ postId: POST, index: 3, userId: AUTHOR })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(w.postText.create).not.toHaveBeenCalled();
  });
});

describe('setPostText', () => {
  it('resets the rating to 0 in the same write, scans the new text and recomputes the post', async () => {
    await setPostText({ id: TEXT, content: '<p>new</p>', userId: AUTHOR });
    expect(w.postText.update).toHaveBeenCalledWith({
      where: { id: TEXT },
      data: { content: '<p>new</p>', nsfwLevel: 0 },
    });
    expect(scanEntityInBackground).toHaveBeenCalledWith({ entityType: 'PostText', entityId: TEXT });
    expect(updatePostNsfwLevels).toHaveBeenCalledWith([POST]);
  });

  it('writes and bills nothing for unchanged text', async () => {
    await setPostText({ id: TEXT, content: '<p>old</p>', userId: AUTHOR });
    expect(w.postText.update).not.toHaveBeenCalled();
    expect(scanEntityInBackground).not.toHaveBeenCalled();
  });

  it('refuses text over 5,000 characters without its tags, and what the blocklist rejects', async () => {
    const long = `<p>${'a'.repeat(5001)}</p>`;
    await expect(setPostText({ id: TEXT, content: long, userId: AUTHOR })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    // The control: the same length counted with its tags is within the cap.
    await setPostText({ id: TEXT, content: `<p>${'a'.repeat(4990)}</p>`, userId: AUTHOR });
    expect(w.postText.update).toHaveBeenCalledTimes(1);

    vi.mocked(throwOnBlockedUserContent).mockRejectedValueOnce(new Error('blocked'));
    await expect(setPostText({ id: TEXT, content: '<p>bad</p>', userId: AUTHOR })).rejects.toThrow(
      'blocked'
    );
    expect(w.postText.update).toHaveBeenCalledTimes(1);
  });

  it('keeps the rating of a markup-only edit, which the scan would skip as unchanged', async () => {
    await setPostText({ id: TEXT, content: '<p><strong>old</strong></p>', userId: AUTHOR });
    expect(w.postText.update).toHaveBeenCalledWith({
      where: { id: TEXT },
      data: { content: '<p><strong>old</strong></p>' },
    });
    expect(scanEntityInBackground).not.toHaveBeenCalled();
  });

  it('runs the blocklist over a markup-only edit, which is where a link lives', async () => {
    vi.mocked(throwOnBlockedUserContent).mockRejectedValueOnce(new Error('blocked'));
    await expect(
      setPostText({ id: TEXT, content: '<p><a href="https://x.test">old</a></p>', userId: AUTHOR })
    ).rejects.toThrow('blocked');
    expect(w.postText.update).not.toHaveBeenCalled();
  });

  it("refuses someone else's text, a moderator's included", async () => {
    await expect(setPostText({ id: TEXT, content: '<p>x</p>', userId: 99 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      setPostText({ id: TEXT, content: '<p>x</p>', userId: 99, isModerator: true })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(w.postText.update).not.toHaveBeenCalled();
  });
});

describe('deletePostText', () => {
  it("deletes the author's text and recomputes the post without it", async () => {
    await deletePostText({ id: TEXT, userId: AUTHOR });
    expect(w.postText.delete).toHaveBeenCalledWith({ where: { id: TEXT } });
    expect(updatePostNsfwLevels).toHaveBeenCalledWith([POST]);
  });

  it("refuses someone else's text; a moderator may delete it", async () => {
    await expect(deletePostText({ id: TEXT, userId: 99 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(w.postText.delete).not.toHaveBeenCalled();
    await deletePostText({ id: TEXT, userId: 99, isModerator: true });
    expect(w.postText.delete).toHaveBeenCalledTimes(1);
  });

  it('keeps text under a CSAM hold from its author, not from a moderator', async () => {
    stored('<p>old</p>', true);
    await expect(deletePostText({ id: TEXT, userId: AUTHOR })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(w.postText.delete).not.toHaveBeenCalled();
    await deletePostText({ id: TEXT, userId: 99, isModerator: true });
    expect(w.postText.delete).toHaveBeenCalledTimes(1);
  });
});

describe('what readers are shown', () => {
  const rows = [
    { id: 1, postId: POST, index: 0, content: 'pg', nsfwLevel: NsfwLevel.PG, refused: false },
    { id: 2, postId: POST, index: 1, content: 'xxx', nsfwLevel: NsfwLevel.XXX, refused: false },
  ];

  it('asks only for scanned, unrefused, unheld rows, then holds them to the level', async () => {
    r.postText.findMany.mockResolvedValue(rows as never);
    const texts = await getPostTextsForViewer({
      postId: POST,
      browsingLevel: NsfwLevel.PG | NsfwLevel.PG13,
      seesAll: false,
    });
    expect(r.postText.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { postId: POST, refused: false, csamHeld: false, nsfwLevel: { not: 0 } },
      })
    );
    expect(texts.map((t) => t.id)).toEqual([1]);
  });

  it('gives the author every row', async () => {
    r.postText.findMany.mockResolvedValue(rows as never);
    const texts = await getPostTextsForViewer({
      postId: POST,
      browsingLevel: NsfwLevel.PG,
      seesAll: true,
    });
    expect(r.postText.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { postId: POST } })
    );
    expect(texts.map((t) => t.id)).toEqual([1, 2]);
  });

  it("holds the path's stubs to the storyline ceiling, with no content", async () => {
    r.postText.findMany.mockResolvedValue(rows as never);
    const stubs = await getStorylineTextStubs({
      postIds: [POST],
      browsingLevel: NsfwLevel.PG | NsfwLevel.XXX,
      maxNsfwLevel: NsfwLevel.R,
    });
    expect(stubs).toEqual([{ id: 1, postId: POST, index: 0, nsfwLevel: NsfwLevel.PG }]);
    expect(r.postText.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { postId: { in: [POST] }, refused: false, csamHeld: false, nsfwLevel: { not: 0 } },
      })
    );
  });
});
