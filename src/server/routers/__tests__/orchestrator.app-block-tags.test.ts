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

// Decision (civitai/civitai#10435): only an App Blocks submit puts an app-block tag on a workflow; this generation entry
// refuses one through the same check the workflow tag patch uses.
describe('generateFromGraph app-block tags', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    'app-block:my-app',
    'App-Block:my-app',
    '  app-block:my-app',
    'app-block',
    ' App-Block ',
  ])('🔴 refuses a submit carrying %j before building the generation context', async (tag) => {
    expect(
      await errorOf(caller().generateFromGraph({ input: {}, tags: ['favorite', tag] }))
    ).toEqual({
      code: 'BAD_REQUEST',
      message: 'App block tags are set by the app, not added by hand.',
    });
    expect(h.buildGenerationContext).not.toHaveBeenCalled();
  });

  it.each([
    { tags: 'app-block:my-app' },
    { tags: ['favorite', 7] },
    { tags: { 0: 'app-block:x' } },
  ])('🔴 refuses tags that are not a list of strings: $tags', async ({ tags }) => {
    expect(await errorOf(caller().generateFromGraph({ input: {}, tags }))).toEqual({
      code: 'BAD_REQUEST',
      message: 'tags must be a list of strings.',
    });
    expect(h.buildGenerationContext).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: no tags reach the generation context', async () => {
    await errorOf(caller().generateFromGraph({ input: {} }));
    expect(h.buildGenerationContext).toHaveBeenCalledTimes(1);
  });

  it('POSITIVE CONTROL: ordinary tags reach the generation context', async () => {
    await errorOf(caller().generateFromGraph({ input: {}, tags: ['favorite', 'my-app-block:x'] }));
    expect(h.buildGenerationContext).toHaveBeenCalledTimes(1);
  });
});
