import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';

const h = vi.hoisted(() => ({ sql: [] as string[], postId: null as number | null }));

vi.mock('../db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(h.sql, () => [{ metadata: {}, postId: h.postId, parentId: null }]);
  return { dbRead: db, dbWrite: db };
});
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../image-moderation-effects', () => ({
  bustPostGalleryCaches: vi.fn(async () => undefined),
}));
vi.mock('../profile-picture-cache', () => ({ bustProfilePictures: vi.fn(async () => undefined) }));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../kono', () => ({ syncKonoFinalize: vi.fn(async () => undefined) }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(async () => undefined) }));
vi.mock('../image-models-reindex', () => ({
  queueModelsForImageChildTagChanges: vi.fn(async () => undefined),
}));

const { updateImageNsfwLevel } = await import('../image-nsfw-level');
const { queueModelsForImageChildTagChanges } = await import('../image-models-reindex');

beforeEach(() => {
  vi.clearAllMocks();
  h.sql.length = 0;
});

describe('spoke updateImageNsfwLevel: models index', () => {
  it('hands the re-rated post image over', async () => {
    h.postId = 5;

    await updateImageNsfwLevel({ id: 41, nsfwLevel: 8, userId: 1 });

    expect(queueModelsForImageChildTagChanges).toHaveBeenCalledWith({ levelImageIds: [41] });
  });

  it('skips an image on no post', async () => {
    h.postId = null;

    await updateImageNsfwLevel({ id: 41, nsfwLevel: 8, userId: 1 });

    expect(queueModelsForImageChildTagChanges).not.toHaveBeenCalled();
  });
});
