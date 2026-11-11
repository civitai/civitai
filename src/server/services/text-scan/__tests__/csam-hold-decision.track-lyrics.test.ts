import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

const mocks = vi.hoisted(() => ({
  unpublishPost: vi.fn(),
  createStrike: vi.fn(),
  queueSearch: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/article.service', () => ({ unpublishArticleById: vi.fn() }));
vi.mock('~/server/services/chat.service', () => ({ deleteChatMessage: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({
  toggleBan: vi.fn(),
  clearUserProfileFields: vi.fn(),
}));
vi.mock('~/server/services/strike.service', () => ({ createStrike: mocks.createStrike }));
vi.mock('~/server/services/model.service', () => ({ unpublishModelById: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({
  unpublishPostAsModerator: mocks.unpublishPost,
}));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate: mocks.queueSearch,
}));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));
vi.mock('~/server/services/text-scan/actions/csam-hold', () => ({ lockCsamHold: vi.fn() }));

const { decideCsamHold } = await import('~/server/services/text-scan/csam-hold-decision');

const w = dbMock.dbWrite;
const SONG = 70;
const decide = (decision: 'dismiss' | 'remove' | 'remove_strike') =>
  decideCsamHold({
    holdId: 5,
    textHash: 'h',
    decision,
    actor: { id: 1 },
    tracker: {} as never,
  });

beforeEach(() => {
  vi.clearAllMocks();
  w.textScanHold.findFirst.mockResolvedValue({
    id: 5,
    status: 'Pending',
    entityType: 'TrackLyrics',
    entityId: SONG,
    userId: 9,
    text: 'held lyrics',
    textHash: 'h',
    meta: {},
  } as never);
  w.$queryRaw.mockResolvedValueOnce([{ at: 'now' }] as never);
  w.textScanHold.updateMany.mockResolvedValue({ count: 1 } as never);
  w.image.findUnique.mockResolvedValue({ postId: 300 } as never);
});

describe('a csam hold on a song', () => {
  it('removes the song by unpublishing its post, and does not put it back in search', async () => {
    await decide('remove');

    expect(mocks.unpublishPost).toHaveBeenCalledWith(
      expect.objectContaining({ id: 300, userId: 1 })
    );
    expect(mocks.queueSearch).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: SearchIndexUpdateQueueAction.Update })
    );
  });

  it('strikes the author against the song image, which is an entity type a strike can carry', async () => {
    await decide('remove_strike');

    expect(mocks.createStrike).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 9, entityType: 'Image', entityId: SONG })
    );
  });

  it('puts a dismissed song back in search', async () => {
    await decide('dismiss');

    expect(mocks.queueSearch).toHaveBeenCalledWith({
      ids: [SONG],
      action: SearchIndexUpdateQueueAction.Update,
    });
    expect(mocks.unpublishPost).not.toHaveBeenCalled();
  });
});
