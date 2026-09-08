import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ArticleService from '~/server/services/article.service';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/**
 * `article.getScanStatus` returns author-facing scan detail — per-image URLs, `blockedFor`
 * moderation labels, scan failure reasons and the article's text-moderation verdict — for any
 * article id, including an unpublished draft. Its `rescan` sibling takes the same input and is
 * owner-scoped, so this asserts the read is too.
 *
 * Drives the REAL router through `createCaller`, so the middleware wiring decides rather than a
 * source scan. Every UI caller is already behind the author's own editor or `isOwner` on the
 * article page, which is exactly why a server-side gap here stayed invisible.
 */

const { mockGetArticleScanStatus, mockFindUnique } = vi.hoisted(() => ({
  mockGetArticleScanStatus: vi.fn(),
  mockFindUnique: vi.fn(),
}));

vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleService>()),
  getArticleScanStatus: mockGetArticleScanStatus,
}));

// `isOwnerOrModerator` resolves the article's owner itself; this is the row it reads.
vi.mock('~/server/db/client', () => ({
  dbRead: { article: { findUnique: mockFindUnique } },
  dbWrite: { article: { findUnique: mockFindUnique } },
}));

// The procedure sits behind `isFlagProtected('articleImageScanning')`. Left off, every
// assertion below would pass on the flag's FORBIDDEN instead of the authorization it is
// meant to be testing.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ articleImageScanning: true }),
}));

import { articleRouter } from '../article.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { articleImageScanning: true } as never,
    track: undefined,
  };
}

const ARTICLE_ID = 34978;
const OWNER_ID = 9911044;

const owner = { id: OWNER_ID, isModerator: false, tier: 'free', muted: false, bannedAt: null };
const stranger = { id: 4242, isModerator: false, tier: 'free', muted: false, bannedAt: null };
const moderator = { id: 1, isModerator: true, tier: 'free', muted: false, bannedAt: null };

const scanStatus = {
  total: 1,
  scanned: 0,
  blocked: 1,
  error: 0,
  pending: 0,
  allComplete: true,
  images: { blocked: [], error: [], pending: [] },
  textModeration: { required: false, status: null, blocked: null, retryCount: 0, updatedAt: null },
};

describe('article.getScanStatus authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetArticleScanStatus.mockResolvedValue(scanStatus);
    mockFindUnique.mockResolvedValue({ userId: OWNER_ID });
  });

  it('rejects an anonymous caller, and does not reach the service', async () => {
    const caller = articleRouter.createCaller(fakeCtx(undefined) as never);

    await expect(caller.getScanStatus({ id: ARTICLE_ID })).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetArticleScanStatus).not.toHaveBeenCalled();
  });

  it('rejects a signed-in stranger, and does not reach the service', async () => {
    const caller = articleRouter.createCaller(fakeCtx(stranger) as never);

    await expect(caller.getScanStatus({ id: ARTICLE_ID })).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetArticleScanStatus).not.toHaveBeenCalled();
  });

  it('rejects a stranger asking about an article that does not exist', async () => {
    mockFindUnique.mockResolvedValue(null);
    const caller = articleRouter.createCaller(fakeCtx(stranger) as never);

    await expect(caller.getScanStatus({ id: ARTICLE_ID })).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetArticleScanStatus).not.toHaveBeenCalled();
  });

  // The control for the three refusals above. Without it they all pass for a route that
  // rejects everyone, including the author it exists to serve — which reads as "well guarded"
  // and ships a scan panel that never loads.
  it('lets the author through and returns the scan status', async () => {
    const caller = articleRouter.createCaller(fakeCtx(owner) as never);

    await expect(caller.getScanStatus({ id: ARTICLE_ID })).resolves.toEqual(scanStatus);
    expect(mockGetArticleScanStatus).toHaveBeenCalledWith({ id: ARTICLE_ID });
  });

  it('lets a moderator through without an ownership lookup', async () => {
    const caller = articleRouter.createCaller(fakeCtx(moderator) as never);

    await expect(caller.getScanStatus({ id: ARTICLE_ID })).resolves.toEqual(scanStatus);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});
