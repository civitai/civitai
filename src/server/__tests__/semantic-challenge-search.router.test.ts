import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const h = vi.hoisted(() => ({
  search: vi.fn(async (_args: unknown) => ({ items: [], nextCursor: undefined })),
  cap: undefined as number | undefined,
}));
vi.mock('~/server/services/semantic-challenge-search.service', () => ({
  searchSemanticChallenges: h.search,
}));
vi.mock('~/server/utils/browsing-level', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestDomainBrowsingLevelCap: () => h.cap,
}));

const { createCallerFactory } = await import('~/server/trpc');
const { semanticChallengeSearchRouter } = await import(
  '~/server/routers/semantic-challenge-search.router'
);

const callerWith = (features: Record<string, boolean>) =>
  createCallerFactory(semanticChallengeSearchRouter)({
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { trpcFlagGuardPerRequest: true, challengePlatform: true, ...features },
    track: { search: vi.fn(async () => undefined) },
    ip: '127.0.0.1',
    cache: {},
    req: { headers: {} },
    res: undefined,
  } as never);

beforeEach(() => h.search.mockClear());

describe('semanticChallengeSearch.search', () => {
  const caller = callerWith({
    semanticChallengeSearch: true,
    isGreen: true,
    userChallenges: false,
  });

  it.each([[1], [undefined]])("hands the service the site's cap (%s)", async (cap) => {
    h.cap = cap;
    await caller.search({ query: 'neon' });
    expect(h.search).toHaveBeenCalledWith(expect.objectContaining({ browsingLevelCap: cap }));
  });

  it("hands the service the site's currency and user-challenge access", async () => {
    await caller.search({ query: 'neon' });
    expect(h.search).toHaveBeenCalledWith(
      expect.objectContaining({ isGreen: true, canAccessUserChallenges: false })
    );
  });

  it('is closed while its flag is off', async () => {
    await expect(
      callerWith({ semanticChallengeSearch: false }).search({ query: 'neon' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.search).not.toHaveBeenCalled();
  });
});
