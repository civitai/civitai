import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestrationNew from '~/server/services/orchestrator/orchestration-new.service';

// 🔴 Do NOT mock `~/env/server` here — see `deprecated-rewards.gate.test.ts` for why importing
// `orchestrator.router` relies on the canonical env mock.

const h = vi.hoisted(() => ({
  buildGenerationContext: vi.fn(async () => ({ externalCtx: {}, status: { available: false } })),
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
import { TokenScope } from '~/shared/constants/token-scope.constants';

const caller = () =>
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

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message })
  );

describe('generateFromGraph source metadata cap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses source metadata far over the cap before building the generation context', async () => {
    const node = { prompt: 'x'.repeat(10_000) };
    const sourceMetadataMap = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, i) => [`https://a/${i}.png`, { params: node }])
    );
    const TOO_LARGE = { code: 'PAYLOAD_TOO_LARGE', message: 'sourceMetadata is too large' };
    expect(await errorOf(caller().generateFromGraph({ input: {}, sourceMetadataMap }))).toEqual(
      TOO_LARGE
    );
    // The single-image field is capped too.
    const sourceMetadata = { resources: new Array(5_000).fill(node) };
    expect(await errorOf(caller().generateFromGraph({ input: {}, sourceMetadata }))).toEqual(
      TOO_LARGE
    );
    expect(h.buildGenerationContext).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: ordinary source metadata reaches the generation context', async () => {
    await errorOf(
      caller().generateFromGraph({
        input: {},
        sourceMetadata: { params: { prompt: 'a cat' } },
      })
    );
    expect(h.buildGenerationContext).toHaveBeenCalledTimes(1);
  });
});
