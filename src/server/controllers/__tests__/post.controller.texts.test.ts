import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';

const mocks = vi.hoisted(() => ({
  getPostDetail: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
  getPostTextsForViewer: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
  reorderPostImages: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
}));

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPostDetail: mocks.getPostDetail,
  reorderPostImages: mocks.reorderPostImages,
}));
vi.mock('~/server/services/post-text.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPostTextsForViewer: mocks.getPostTextsForViewer,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  amIBlockedByUser: vi.fn(async () => false),
}));
vi.mock('~/server/services/blocks/post-app-chip.service', () => ({
  readPostAppChip: vi.fn(async () => null),
}));

import { getPostHandler, reorderPostImagesHandler } from '~/server/controllers/post.controller';

const POST = 31;
const AUTHOR = 5;
const ctx = (over: Record<string, unknown> = {}) =>
  ({
    user: undefined,
    features: { canViewNsfw: false, storylineText: true },
    req: { headers: { host: 'civitai.green' } },
    ...over,
  } as never);

const levelAsked = () =>
  (mocks.getPostTextsForViewer.mock.calls[0][0] as { browsingLevel: number }).browsingLevel;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPostDetail.mockResolvedValue({ id: POST, user: { id: AUTHOR } });
  mocks.getPostTextsForViewer.mockResolvedValue([{ id: 1 }]);
});

describe("post.get's storyline text items", () => {
  it('asks a signed-out viewer on the SFW domain for no R text, and returns what it got', async () => {
    const result = (await getPostHandler({ input: { id: POST }, ctx: ctx() })) as {
      texts: unknown[];
    };
    expect(result.texts).toEqual([{ id: 1 }]);
    expect(levelAsked() & NsfwLevel.R).toBe(0);
    expect(levelAsked() & NsfwLevel.PG).toBe(NsfwLevel.PG);
  });

  it('gives the author every row, and another viewer only what is shown', async () => {
    const author = { id: AUTHOR, isModerator: false, browsingLevel: 31, showNsfw: true };
    await getPostHandler({ input: { id: POST }, ctx: ctx({ user: author }) });
    expect(mocks.getPostTextsForViewer).toHaveBeenLastCalledWith(
      expect.objectContaining({ seesAll: true })
    );
    await getPostHandler({ input: { id: POST }, ctx: ctx({ user: { ...author, id: 77 } }) });
    expect(mocks.getPostTextsForViewer).toHaveBeenLastCalledWith(
      expect.objectContaining({ seesAll: false })
    );
    // A moderator reviewing someone else's post sees every row.
    const moderator = { ...author, id: 77, isModerator: true };
    await getPostHandler({ input: { id: POST }, ctx: ctx({ user: moderator }) });
    expect(mocks.getPostTextsForViewer).toHaveBeenLastCalledWith(
      expect.objectContaining({ seesAll: true })
    );
  });

  it('returns none with the flag off, without reading them', async () => {
    const result = (await getPostHandler({
      input: { id: POST },
      ctx: ctx({ features: { canViewNsfw: false, storylineText: false } }),
    })) as { texts: unknown[] };
    expect(result.texts).toEqual([]);
    expect(mocks.getPostTextsForViewer).not.toHaveBeenCalled();
  });

  it('reads none for a post the viewer may not see', async () => {
    mocks.getPostDetail.mockResolvedValue(null);
    await expect(getPostHandler({ input: { id: POST }, ctx: ctx() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.getPostTextsForViewer).not.toHaveBeenCalled();
  });
});

describe('post.reorderImages', () => {
  const items = [
    { type: 'text' as const, id: 1 },
    { type: 'image' as const, id: 2 },
  ];
  const reorder = (storylineText: boolean, withItems = true) =>
    reorderPostImagesHandler({
      input: { id: POST, imageIds: [2], ...(withItems ? { items } : {}) },
      ctx: ctx({ user: { id: AUTHOR }, features: { storylineText } }),
    });

  it('moves text items only with the storylineText flag', async () => {
    await expect(reorder(false)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mocks.reorderPostImages).not.toHaveBeenCalled();
    await reorder(false, false);
    await reorder(true);
    expect(mocks.reorderPostImages).toHaveBeenCalledTimes(2);
  });
});
