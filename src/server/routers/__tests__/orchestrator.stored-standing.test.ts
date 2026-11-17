import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestrationNew from '~/server/services/orchestrator/orchestration-new.service';
import type * as TosReacceptance from '~/server/services/tos-reacceptance.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';

// 🔴 Do NOT mock `~/env/server` here — see `deprecated-rewards.gate.test.ts`.

const h = vi.hoisted(() => ({
  shouldOfferTosReacceptance: vi.fn(async (_userId: number) => false),
  buildGenerationContext: vi.fn(async () => ({ externalCtx: {}, status: { available: false } })),
}));

vi.mock('~/server/services/tos-reacceptance.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TosReacceptance>()),
  shouldOfferTosReacceptance: h.shouldOfferTosReacceptance,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'token'),
}));
vi.mock('~/server/services/orchestrator/experimental', () => ({
  getExperimentalFlags: vi.fn(async () => ({ experimental: false })),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationNew>()),
  buildGenerationContext: h.buildGenerationContext,
}));

import { orchestratorRouter } from '~/server/routers/orchestrator.router';
import { OnboardingSteps } from '~/server/common/enums';
import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** The session's copy of the standing says not muted; the stored standing decides. */
const callerWithSession = () =>
  orchestratorRouter.createCaller({
    user: {
      id: 7,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date('2020-01-01'),
      muted: false,
      bannedAt: null,
      showNsfw: false,
    },
    ip: '1.2.3.4',
    features: {},
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
  } as never);

const givenStoredMute = (muted: boolean) =>
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted } as never);

describe('a guarded generate follows the stored account standing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.user.findUnique.mockReset();
    installFakeCacheRedis();
  });

  it('is refused when the stored account is muted', async () => {
    givenStoredMute(true);
    await expect(callerWithSession().generateFromGraph({ input: {} })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: RESTRICTED_ACCOUNT_MESSAGE,
    });
    expect(h.buildGenerationContext).not.toHaveBeenCalled();
  });

  it('still offers the Terms when only the stored standing says muted', async () => {
    givenStoredMute(true);
    h.shouldOfferTosReacceptance.mockResolvedValueOnce(true);
    const error = await callerWithSession()
      .generateFromGraph({ input: {} })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'FORBIDDEN', cause: { tosReacceptRequired: true } });
    expect(h.shouldOfferTosReacceptance).toHaveBeenCalledWith(7);
  });

  it('CONTROL: goes through when the stored account is not muted', async () => {
    givenStoredMute(false);
    await callerWithSession()
      .generateFromGraph({ input: {} })
      .catch(() => undefined);
    expect(h.buildGenerationContext).toHaveBeenCalledTimes(1);
  });
});
