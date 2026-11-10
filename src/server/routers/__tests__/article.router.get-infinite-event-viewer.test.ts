import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/**
 * The article feed decorates each card with its event hat, gated on the viewer it is given. Before
 * launch only a flagged viewer sees hats, and a moderator is in every flag audience, so the viewer
 * must be eventViewerOf(ctx): a moderator counts only on a session or a full-access personal key,
 * never on a scoped or OAuth token (as for article.getById and image.get).
 */

const { mockGetArticles } = vi.hoisted(() => ({ mockGetArticles: vi.fn() }));

vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getArticles: mockGetArticles,
}));

import { articleRouter } from '../article.router';

const moderator = { id: 1, isModerator: true, tier: 'free', muted: false, bannedAt: null };
const member = { id: 2, isModerator: false, tier: 'free', muted: false, bannedAt: null };

const session = { apiKeyId: null, tokenScope: TokenScope.Full };
const scopedKey = {
  apiKeyId: 5,
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey' as const, id: 5 },
  tokenScope: TokenScope.ArticlesRead,
};
const oauthToken = {
  apiKeyId: 6,
  apiKeyType: ApiKeyType.Access,
  subject: { type: 'oauth' as const, id: 'client-1' },
  tokenScope: TokenScope.Full,
};

function fakeCtx(user: unknown, credential: Record<string, unknown>) {
  return {
    acceptableOrigin: true,
    user,
    ...credential,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

const feed = { items: [{ id: 7, title: 'An article' }], nextCursor: undefined };

async function viewerFor(user: unknown, credential: Record<string, unknown>) {
  const caller = articleRouter.createCaller(fakeCtx(user, credential) as never);
  const result = await caller.getInfinite({});
  expect(result).toEqual(feed);
  return mockGetArticles.mock.calls.at(-1)![0].eventDecorationViewer;
}

describe('article.getInfinite event decoration viewer', () => {
  beforeEach(() => {
    mockGetArticles.mockReset();
    mockGetArticles.mockResolvedValue(feed);
  });

  it('a moderator on a scoped token is not a moderator to the hat gate', async () => {
    expect(await viewerFor(moderator, scopedKey)).toEqual({ id: 1, isModerator: false });
  });

  it('a moderator on an OAuth token is not a moderator to the hat gate', async () => {
    expect(await viewerFor(moderator, oauthToken)).toEqual({ id: 1, isModerator: false });
  });

  it('a moderator on a session is', async () => {
    expect(await viewerFor(moderator, session)).toEqual({ id: 1, isModerator: true });
  });

  it('a member reads as the member, and the feed comes back unchanged', async () => {
    expect(await viewerFor(member, session)).toEqual({ id: 2, isModerator: false });
  });
});
