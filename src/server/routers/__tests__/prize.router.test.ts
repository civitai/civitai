import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MiddlewareTrpc from '~/server/middleware.trpc';
import type * as PrizeService from '~/server/services/prize.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Prod's shape: civitai.red is configured as both the blue and the red domain.
vi.stubEnv('SERVER_DOMAIN_GREEN', 'civitai.com');
vi.stubEnv('SERVER_DOMAIN_BLUE', 'civitai.red');
vi.stubEnv('SERVER_DOMAIN_RED', 'civitai.red');
vi.resetModules();

const { mockClaimPrize, mockGetPrize, mockGetMyPrizes } = vi.hoisted(() => ({
  mockClaimPrize: vi.fn(),
  mockGetPrize: vi.fn(),
  mockGetMyPrizes: vi.fn(),
}));

// The currency choice is computed for real; only the calls that would reach the database are cut.
vi.mock('~/server/services/prize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PrizeService>()),
  claimPrize: mockClaimPrize,
  getPrize: mockGetPrize,
  getMyPrizes: mockGetMyPrizes,
}));
vi.mock('~/server/middleware.trpc', async (importOriginal) => {
  const { middleware } = await import('~/server/trpc');
  return {
    ...(await importOriginal<typeof MiddlewareTrpc>()),
    rateLimit: () => middleware(async ({ next }) => next()),
  };
});

const { prizeRouter } = await import('~/server/routers/prize.router');

// `domain` is what createContext puts on ctx: an unresolved host defaults to blue there.
const callerOn = (host: string | undefined, domain = 'blue') =>
  prizeRouter.createCaller({
    user: { id: 7 },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    domain,
    req: { headers: host ? { host } : {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockClaimPrize.mockResolvedValue({});
  mockGetPrize.mockResolvedValue({});
  mockGetMyPrizes.mockResolvedValue([]);
});

describe('the prize router decides the currency choice from the request host', () => {
  it.each([
    ['civitai.com', 'green', ['green']],
    ['civitai.red', 'blue', ['green', 'yellow']],
    ['evil.example', 'blue', ['green']],
    [undefined, 'blue', ['green']],
  ] as const)('on host %s', async (host, domain, choices) => {
    const caller = callerOn(host, domain);

    await caller.claim({ id: 1, buzzType: 'yellow' });
    await caller.getById({ id: 1 });
    await caller.getMine();

    expect(mockClaimPrize).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, userId: 7, buzzType: 'yellow', choices })
    );
    expect(mockGetPrize).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, choices }));
    expect(mockGetMyPrizes).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, choices }));
  });
});
