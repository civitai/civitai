import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as Submit from '~/server/services/text-scan/submit';

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof Submit>()),
  scanEntityInBackground: vi.fn(),
}));

const { setStorylineImageCaption, getStorylineImageCaptions, isImageCaptionShown } = await import(
  '~/server/services/storyline-caption.service'
);
const { throwOnBlockedUserContent } = await import('~/server/services/blocklist.service');
const { scanEntityInBackground } = await import('~/server/services/text-scan/submit');

const w = dbMock.dbWrite;
const r = dbMock.dbRead;
const AUTHOR = 7;
const IMAGE = 40;

const set = (content: string, userId = AUTHOR) =>
  setStorylineImageCaption({ imageId: IMAGE, content, userId });

describe('setStorylineImageCaption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    w.image.findUnique.mockResolvedValue({ postId: 5, post: { userId: AUTHOR } } as never);
    w.storylineChapter.findFirst.mockResolvedValue({ id: 9 } as never);
    w.imageCaption.findUnique.mockResolvedValue(null as never);
  });

  it('writes the trimmed text and scans it as an ImageCaption', async () => {
    await expect(set('  A robot learns to talk.  ')).resolves.toEqual({
      imageId: IMAGE,
      content: 'A robot learns to talk.',
    });
    expect(throwOnBlockedUserContent).toHaveBeenCalledWith('A robot learns to talk.', {
      isModerator: undefined,
      surface: 'storyline-caption',
    });
    expect(w.imageCaption.upsert).toHaveBeenCalledWith({
      where: { imageId: IMAGE },
      create: { imageId: IMAGE, userId: AUTHOR, content: 'A robot learns to talk.' },
      update: { content: 'A robot learns to talk.' },
    });
    expect(scanEntityInBackground).toHaveBeenCalledWith({
      entityType: 'ImageCaption',
      entityId: IMAGE,
    });
  });

  it('refuses anyone but the post author, writing nothing', async () => {
    await expect(set('Mine now', 8)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(w.imageCaption.upsert).not.toHaveBeenCalled();
    expect(w.imageCaption.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses an image whose post is not a live storyline chapter', async () => {
    w.storylineChapter.findFirst.mockResolvedValue(null as never);
    await expect(set('A note')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(w.storylineChapter.findFirst).toHaveBeenCalledWith({
      where: { postId: 5, removedAt: null },
      select: { id: true },
    });
    expect(w.imageCaption.upsert).not.toHaveBeenCalled();
  });

  it('deletes the caption for empty text, with no scan', async () => {
    await expect(set('   ')).resolves.toBeNull();
    expect(w.imageCaption.deleteMany).toHaveBeenCalledWith({ where: { imageId: IMAGE } });
    expect(w.imageCaption.upsert).not.toHaveBeenCalled();
    expect(scanEntityInBackground).not.toHaveBeenCalled();
  });

  it('stores nothing the blocklist rejects', async () => {
    vi.mocked(throwOnBlockedUserContent).mockRejectedValueOnce(new Error('blocked'));
    await expect(set('bad words')).rejects.toThrow('blocked');
    expect(w.imageCaption.upsert).not.toHaveBeenCalled();
    expect(scanEntityInBackground).not.toHaveBeenCalled();
  });
});

describe('isImageCaptionShown', () => {
  const reader = { browsingLevel: NsfwLevel.PG | NsfwLevel.PG13, maxNsfwLevel: NsfwLevel.R };

  it.each([
    ['unscanned', { refused: false, nsfwLevel: 0 }, true],
    [
      'rated within the reader and the ceiling',
      { refused: false, nsfwLevel: NsfwLevel.PG13 },
      true,
    ],
    ['refused', { refused: true, nsfwLevel: NsfwLevel.PG }, false],
    ['rated above the reader', { refused: false, nsfwLevel: NsfwLevel.R }, false],
  ])('%s: %s', (_, caption, shown) => {
    expect(isImageCaptionShown(caption, reader)).toBe(shown);
  });

  it('hides a caption rated above the storyline ceiling even for a reader who sees it', () => {
    expect(
      isImageCaptionShown(
        { refused: false, nsfwLevel: NsfwLevel.X },
        { browsingLevel: NsfwLevel.X, maxNsfwLevel: NsfwLevel.R }
      )
    ).toBe(false);
  });
});

describe('getStorylineImageCaptions', () => {
  const read = (over: Partial<Parameters<typeof getStorylineImageCaptions>[0]> = {}) =>
    getStorylineImageCaptions({
      postIds: [5],
      browsingLevel: NsfwLevel.PG,
      maxNsfwLevel: NsfwLevel.R,
      viewerId: 3,
      hiddenImageIds: [11],
      hiddenTagIds: [12],
      ...over,
    });
  const row = (imageId: number, imageLevel: number) => ({
    imageId,
    content: `caption ${imageId}`,
    refused: false,
    nsfwLevel: 0,
    image: { nsfwLevel: imageLevel },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps only captions on images in the reader level, never refused ones', async () => {
    r.imageCaption.findMany.mockResolvedValue([row(1, NsfwLevel.PG), row(2, NsfwLevel.R)] as never);
    expect([...(await read())]).toEqual([[1, 'caption 1']]);
  });

  it('drops a caption on an image above the storyline ceiling the reader would see', async () => {
    r.imageCaption.findMany.mockResolvedValue([row(1, NsfwLevel.X)] as never);
    expect([...(await read({ browsingLevel: NsfwLevel.X }))]).toEqual([]);
  });

  it("reads only images the reader's image gate shows", async () => {
    r.imageCaption.findMany.mockResolvedValue([] as never);
    await read();
    expect(r.imageCaption.findMany.mock.calls[0][0]?.where).toEqual({
      refused: false,
      image: {
        postId: { in: [5] },
        id: { notIn: [11] },
        ingestion: 'Scanned',
        tosViolation: false,
        needsReview: null,
        acceptableMinor: false,
        minor: false,
        poi: false,
        nsfwLevel: { not: 0 },
        OR: [{ tags: { none: { tagId: { in: [12] }, disabled: false } } }, { userId: 3 }],
      },
    });
  });

  it('reads nothing for no chapter posts', async () => {
    expect([...(await read({ postIds: [] }))]).toEqual([]);
    expect(r.imageCaption.findMany).not.toHaveBeenCalled();
  });
});
