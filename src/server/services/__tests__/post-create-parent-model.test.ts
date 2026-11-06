import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as VisibilityService from '~/server/services/model-version-visibility.service';
import type * as Caches from '~/server/redis/caches';

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/model-version-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof VisibilityService>()),
  canViewModelVersion: vi.fn(async () => true),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return { ...actual, userPostCountCache: { ...actual.userPostCountCache, refresh: vi.fn() } };
});

import { createPost } from '~/server/services/post.service';

const POST_OWNER = 7;
const MODEL_OWNER = 8;

/**
 * The editor's back link to the model reads `parentModelId` / `parentModelName`, and a post that was
 * only just created is what the editor opens first: they used to be null there whatever the post's
 * version.
 */
describe('createPost parent model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dbMock.dbWrite.post.create).mockResolvedValue({
      id: 1,
      publishedAt: null,
      collectionId: null,
      modelVersionId: null,
      tags: [],
    } as never);
  });

  it('names the model of a post created on a model version', async () => {
    vi.mocked(dbMock.dbWrite.modelVersion.findUnique).mockResolvedValue({
      model: { id: 3, name: 'My Model', userId: MODEL_OWNER, availability: 'Public' },
    } as never);

    const post = await createPost({ userId: POST_OWNER, modelVersionId: 5 });

    expect(post.parentModelId).toBe(3);
    expect(post.parentModelName).toBe('My Model');
    expect(post.ownModelId).toBeNull();
  });

  it('marks the model the post owner’s own when they own both', async () => {
    vi.mocked(dbMock.dbWrite.modelVersion.findUnique).mockResolvedValue({
      model: { id: 3, name: 'My Model', userId: POST_OWNER, availability: 'Public' },
    } as never);

    const post = await createPost({ userId: POST_OWNER, modelVersionId: 5 });

    expect(post.parentModelId).toBe(3);
    expect(post.ownModelId).toBe(3);
  });

  it('leaves a post without a model version with no model, and looks nothing up', async () => {
    const post = await createPost({ userId: POST_OWNER });

    expect(post.parentModelId).toBeNull();
    expect(post.parentModelName).toBeNull();
    expect(post.ownModelId).toBeNull();
    expect(dbMock.dbWrite.modelVersion.findUnique).not.toHaveBeenCalled();
  });
});
