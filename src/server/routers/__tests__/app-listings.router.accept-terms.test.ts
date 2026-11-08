import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';

const { mockAcceptAppDeveloperTerms } = vi.hoisted(() => ({
  mockAcceptAppDeveloperTerms: vi.fn(async () => ({ ok: true })),
}));

vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppDeveloperTermsService>()),
  acceptAppDeveloperTerms: mockAcceptAppDeveloperTerms,
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { appListingsRouter } from '../app-listings.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { APP_DEVELOPER_TERMS_VERSION } from '~/shared/constants/app-developer-terms.constants';

const caller = () =>
  appListingsRouter.createCaller({
    acceptableOrigin: true,
    user: { id: 100, isModerator: false, onboarding: 0x1f },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { trpcFlagGuardPerRequest: true, appBlocksAuthor: true },
    track: undefined,
  } as never);

describe('appListings.acceptDeveloperTerms', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records acceptance of the current version', async () => {
    await caller().acceptDeveloperTerms({ version: APP_DEVELOPER_TERMS_VERSION });
    expect(mockAcceptAppDeveloperTerms).toHaveBeenCalledWith({
      userId: 100,
      version: APP_DEVELOPER_TERMS_VERSION,
    });
  });

  it('refuses a stale version with CONFLICT and records nothing', async () => {
    await expect(
      caller().acceptDeveloperTerms({ version: `${APP_DEVELOPER_TERMS_VERSION}-stale` })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockAcceptAppDeveloperTerms).not.toHaveBeenCalled();
  });
});
