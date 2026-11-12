import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';

/**
 * The wizard's auto-label upload URL is minted with the requesting user's orchestrator token. The
 * service takes that token through a getter (its own test injects one); this pins that the router
 * supplies a getter resolving the caller's token, for the caller's own request, through the real
 * procedure. Built like `training.router.studio-auto-label-limit.test.ts`.
 */

const h = vi.hoisted(() => ({
  getOrchestratorToken: vi.fn(async (userId: number) => `orchestrator-token-of-${userId}`),
}));
vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isDev: false,
  isTest: false,
  isPreview: false,
  isProd: true,
}));
vi.mock('~/server/redis/atomic', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hSetWithTTL: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/account-standing.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAccountMuted: vi.fn(async () => false),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrchestratorToken: h.getOrchestratorToken,
}));
// The service runs the getter it is handed and reports the token, so the test reads what the
// router supplied.
vi.mock('~/server/services/training.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAutoLabelUploadUrl: vi.fn(
    async ({ getUserToken }: { getUserToken: () => Promise<string> }) => ({
      uploadUrl: await getUserToken(),
      expiresAt: 'e',
    })
  ),
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { trainingRouter } from '~/server/routers/training.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const CALLER_ID = 7;

function caller() {
  return trainingRouter.createCaller({
    acceptableOrigin: true,
    user: {
      id: CALLER_ID,
      isModerator: false,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date(),
    },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {}, socket: { remoteAddress: '10.0.0.1' } },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {
      trpcFlagGuardPerRequest: true,
      imageTraining: true,
      trainingAutoLabelOrchestrator: true,
    },
    track: undefined,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.redis.packed.hGet.mockResolvedValue([]);
});

describe('training.getAutoLabelUploadUrl', () => {
  it("hands the service a getter for the caller's own orchestrator token", async () => {
    await expect(caller().getAutoLabelUploadUrl({ modelId: 1 })).resolves.toEqual({
      uploadUrl: `orchestrator-token-of-${CALLER_ID}`,
      expiresAt: 'e',
    });

    expect(h.getOrchestratorToken).toHaveBeenCalledTimes(1);
    const [userId, ctx] = h.getOrchestratorToken.mock.calls[0] as unknown as [
      number,
      { user: { id: number }; req: unknown }
    ];
    expect(userId).toBe(CALLER_ID);
    // The request's own context, so the token helper can check the caller's credential.
    expect(ctx.user.id).toBe(CALLER_ID);
    expect(ctx.req).toBeDefined();
  });
});
