import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { PostSort } from '~/server/common/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

// Records whether the post query ran and stops there.
class QueryIssued extends Error {}
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  queryCache: () => async () => {
    throw new QueryIssued();
  },
}));

const { getPostsInfinite } = await import('~/server/services/post.service');

/** Posts of a version of a model flagged `poi`: only its owner and moderators get any. */

const OWNER = 7;
const VIEWERS = {
  anon: undefined,
  other: { id: 9, isModerator: false },
  owner: { id: OWNER, isModerator: false },
  moderator: { id: 1, isModerator: true },
} as const;
type ViewerKey = keyof typeof VIEWERS;

async function run(viewer: ViewerKey, poi: boolean) {
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({ model: { poi, userId: OWNER } });
  return getPostsInfinite({
    limit: 10,
    sort: PostSort.Newest,
    period: MetricTimeframe.AllTime,
    periodMode: 'published',
    browsingLevel: 31,
    modelVersionId: 100,
    user: VIEWERS[viewer] as SessionUser | undefined,
  } as Parameters<typeof getPostsInfinite>[0]).then(
    (result) => result,
    (error) => {
      if (error instanceof QueryIssued) return 'queried';
      throw error;
    }
  );
}

beforeEach(() => vi.clearAllMocks());

describe('getPostsInfinite by modelVersionId', () => {
  it.each<[ViewerKey, unknown]>([
    ['anon', { items: [] }],
    ['other', { items: [] }],
    ['owner', 'queried'],
    ['moderator', 'queried'],
  ])('flagged model: %s gets %j', async (viewer, expected) => {
    expect(await run(viewer, true)).toEqual(expected);
  });

  it.each<ViewerKey>(['anon', 'other'])('control: unflagged model is queried for %s', async (v) => {
    expect(await run(v, false)).toBe('queried');
  });
});
