import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as Caches from '~/server/redis/caches';
import type * as TagService from '~/server/services/tag.service';
import type { SessionUser } from '~/types/session';

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));
vi.mock('~/server/services/tag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TagService>()),
  getVotableImageTags: vi.fn(async () => []),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    thumbnailCache: { ...actual.thumbnailCache, fetch: vi.fn(async () => ({})) },
  };
});

import { getPostEditDetail } from '~/server/services/post.service';

const POST_OWNER = 7;
const MODEL_OWNER = 8;
const viewer = (id: number, isModerator = false) => ({ id, isModerator } as SessionUser);

const givenPost = ({
  publishedAt,
  modelVersionId,
}: {
  publishedAt: Date | null;
  modelVersionId: number | null;
}) =>
  vi.mocked(dbMock.dbRead.post.findFirst).mockResolvedValue({
    id: 1,
    publishedAt,
    modelVersionId,
    user: { id: POST_OWNER },
    tags: [],
  } as never);

const givenVersionOf = (model: { id: number; userId: number; name?: string } | null) =>
  vi.mocked(dbMock.dbRead.modelVersion.findUnique).mockResolvedValue(model && ({ model } as never));

/**
 * The editor's "View Model" link needs the model of a post whatever the post's state; the
 * model id used to be resolved only for an unpublished post.
 */
describe('getPostEditDetail model', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['published', new Date('2026-01-01')],
    ['draft', null],
  ])('names the model of a %s post on someone else’s model', async (_, publishedAt) => {
    givenPost({ publishedAt, modelVersionId: 5 });
    givenVersionOf({ id: 3, userId: MODEL_OWNER, name: 'My Model' });

    const post = await getPostEditDetail({ id: 1, user: viewer(POST_OWNER) });

    expect(post.parentModelId).toBe(3);
    expect(post.parentModelName).toBe('My Model');
    expect(post.modelVersionId).toBe(5);
    expect(post.ownModelId).toBeNull();
  });

  it('names the model, and marks it the post owner’s own, when they own both', async () => {
    givenPost({ publishedAt: new Date('2026-01-01'), modelVersionId: 5 });
    givenVersionOf({ id: 3, userId: POST_OWNER });

    const post = await getPostEditDetail({ id: 1, user: viewer(POST_OWNER) });

    expect(post.parentModelId).toBe(3);
    expect(post.ownModelId).toBe(3);
  });

  it('names the model to a moderator editing another user’s post', async () => {
    givenPost({ publishedAt: new Date('2026-01-01'), modelVersionId: 5 });
    givenVersionOf({ id: 3, userId: MODEL_OWNER });

    const post = await getPostEditDetail({ id: 1, user: viewer(99, true) });

    expect(post.parentModelId).toBe(3);
    expect(post.ownModelId).toBeNull();
  });

  it('has no model for a post without a version, and asks nothing', async () => {
    givenPost({ publishedAt: new Date('2026-01-01'), modelVersionId: null });

    const post = await getPostEditDetail({ id: 1, user: viewer(POST_OWNER) });

    expect(post.parentModelId).toBeNull();
    expect(post.parentModelName).toBeNull();
    expect(post.ownModelId).toBeNull();
    expect(dbMock.dbRead.modelVersion.findUnique).not.toHaveBeenCalled();
  });

  it('has no model when the version row is gone', async () => {
    givenPost({ publishedAt: new Date('2026-01-01'), modelVersionId: 5 });
    givenVersionOf(null);

    const post = await getPostEditDetail({ id: 1, user: viewer(POST_OWNER) });

    expect(post.parentModelId).toBeNull();
  });

  it('refuses a user who is neither the owner nor a moderator before looking up the model', async () => {
    givenPost({ publishedAt: new Date('2026-01-01'), modelVersionId: 5 });
    givenVersionOf({ id: 3, userId: MODEL_OWNER });

    await expect(getPostEditDetail({ id: 1, user: viewer(MODEL_OWNER) })).rejects.toThrow();
    expect(dbMock.dbRead.modelVersion.findUnique).not.toHaveBeenCalled();
  });
});
