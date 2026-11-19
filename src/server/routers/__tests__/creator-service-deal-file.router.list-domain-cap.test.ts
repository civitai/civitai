import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type * as DealFileService from '~/server/services/creator-service-deal-file.service';
import {
  browsingLevels,
  parseBitwiseBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The deal file list takes the domain's levels from the request, never the input: on the SFW
 * domain the service must get SFW levels only, or it hands out mature preview URLs there.
 */

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }));

vi.mock('~/server/services/creator-service-deal-file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DealFileService>()),
  listServiceDealFiles: (...args: unknown[]) => mockList(...args),
}));

const { creatorServiceDealFileRouter } = await import('../creator-service-deal-file.router');

const BUYER = 10;

function callerOn(isGreen: boolean) {
  return creatorServiceDealFileRouter.createCaller({
    user: { id: BUYER, tier: 'free', username: 'buyer', muted: false, onboarding: 0xff },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { isGreen, canViewNsfw: true },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

const servedLevels = () => {
  const [args] = mockList.mock.calls[0] as [{ userId: number; servableLevels: number }];
  expect(args.userId).toBe(BUYER);
  return parseBitwiseBrowsingLevel(args.servableLevels);
};

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([]);
});

describe('creatorServiceDealFile.list domain cap', () => {
  it('on the SFW domain hands the service PG and PG13 only', async () => {
    await callerOn(true).list({ dealId: 1 });
    expect(servedLevels()).toEqual([NsfwLevel.PG, NsfwLevel.PG13]);
  });

  it('elsewhere hands the service every level', async () => {
    await callerOn(false).list({ dealId: 1 });
    expect(servedLevels()).toEqual([...browsingLevels]);
  });
});
