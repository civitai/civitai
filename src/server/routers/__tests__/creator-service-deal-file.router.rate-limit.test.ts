import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DealFileService from '~/server/services/creator-service-deal-file.service';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/**
 * The real limiter is bypassed under test (`claimRateLimitAttempt`), so it is stood in for by one
 * that records what it was handed and refuses.
 */

const h = vi.hoisted(() => ({
  request: vi.fn(),
  refuse: false,
  runs: [] as Array<{ path: string; limits: unknown }>,
}));

vi.mock('~/server/services/creator-service-deal-file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DealFileService>()),
  requestServiceDealAttachment: (...a: unknown[]) => h.request(...a),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({ creatorServices: true, creatorServicesAttachments: true }),
}));
vi.mock('~/server/middleware.trpc', async (importOriginal) => {
  const { middleware } = await import('~/server/trpc');
  return {
    ...(await importOriginal<object>()),
    rateLimit: (limits: unknown) =>
      middleware(({ path, next }) => {
        h.runs.push({ path, limits });
        if (h.refuse) throw new TRPCError({ code: 'TOO_MANY_REQUESTS' });
        return next();
      }),
  };
});

const { creatorServiceDealFileRouter, serviceDealAttachmentRateLimits } = await import(
  '~/server/routers/creator-service-deal-file.router'
);

const caller = () =>
  creatorServiceDealFileRouter.createCaller({
    user: {
      id: 7,
      showNsfw: true,
      browsingLevel: allBrowsingLevelsFlag,
      emailVerified: new Date(),
      onboarding: 0xffff,
      muted: false,
    },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { creatorServices: true, creatorServicesAttachments: true },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);

const input = {
  dealId: 1,
  fileName: 'notes.txt',
  mimeType: 'text/plain',
  size: 10,
  rightsAttested: true,
  likenessAttested: true,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  h.runs.length = 0;
  h.refuse = false;
  h.request.mockResolvedValue({ fileId: 1, uploadUrl: 'https://upload' });
});

describe('requestAttachment', () => {
  it('is charged to the attachment rate limit', async () => {
    await caller().requestAttachment(input);
    expect(h.runs).toEqual([
      { path: 'requestAttachment', limits: serviceDealAttachmentRateLimits },
    ]);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('does not reach the service once the limit refuses', async () => {
    h.refuse = true;
    await expect(caller().requestAttachment(input)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(h.request).not.toHaveBeenCalled();
  });
});
