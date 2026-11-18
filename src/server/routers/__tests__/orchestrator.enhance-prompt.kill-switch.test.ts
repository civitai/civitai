import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GenerationService from '~/server/services/generation/generation.service';

/**
 * Onsite prompt enhancement (`orchestrator.enhancePrompt`) is a paid LLM step a caller runs before
 * generating, so the generation kill switch refuses it as it refuses an onsite submit: before the
 * orchestrator token is fetched, the prompt is audited or anything is submitted.
 */

// 🔴 Do NOT mock `~/env/server` here — see `deprecated-rewards.gate.test.ts` for why importing
// `orchestrator.router` relies on the canonical env mock.

const h = vi.hoisted(() => ({
  state: { known: true, status: { mode: 'enabled', message: 'paused' } } as {
    known: boolean;
    status: { mode: string; message: string };
  },
  getOrchestratorToken: vi.fn(async () => 'token'),
  assertInputs: vi.fn(async () => undefined),
  enhancePrompt: vi.fn(async () => ({ id: 'workflow' })),
}));

vi.mock('~/server/services/generation/generation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationService>()),
  getGenerationStatusState: async () => h.state,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: h.getOrchestratorToken,
}));
vi.mock('~/server/services/orchestrator/experimental', () => ({
  getExperimentalFlags: vi.fn(async () => ({ experimental: false })),
}));
vi.mock('~/server/services/generation-input-urls', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertGenerationInputsUsable: h.assertInputs,
}));
vi.mock('~/server/services/orchestrator/promptEnhancement', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enhancePrompt: h.enhancePrompt,
}));

import { orchestratorRouter } from '~/server/routers/orchestrator.router';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

type Caller = { isModerator: boolean; tier?: string };

const enhance = (user: Caller) =>
  orchestratorRouter
    .createCaller({
      user: {
        id: 7,
        onboarding: OnboardingSteps.Buzz,
        emailVerified: new Date('2020-01-01'),
        muted: false,
        bannedAt: null,
        showNsfw: false,
        ...user,
      },
      ip: '1.2.3.4',
      domain: 'red',
      features: {},
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      apiKeyId: null,
      track: {},
    } as never)
    .enhancePrompt({ ecosystem: 'sdxl', prompt: 'a cat' });

const givenSwitch = (mode: string, known = true) => {
  h.state = { known, status: { mode, message: 'paused' } };
};

const expectNothingStarted = () => {
  expect(h.getOrchestratorToken).not.toHaveBeenCalled();
  expect(h.assertInputs).not.toHaveBeenCalled();
  expect(h.enhancePrompt).not.toHaveBeenCalled();
};

const expectEnhanced = () => {
  expect(h.getOrchestratorToken).toHaveBeenCalledTimes(1);
  expect(h.enhancePrompt).toHaveBeenCalledTimes(1);
};

beforeEach(() => {
  vi.clearAllMocks();
  resetEnv();
  givenSwitch('enabled');
});

describe('orchestrator.enhancePrompt obeys the generation kill switch', () => {
  it.each([
    ['disabled', { isModerator: false, tier: 'gold' }],
    ['disabled', { isModerator: false, tier: 'free' }],
    ['memberOnly', { isModerator: false, tier: 'free' }],
    ['memberOnly', { isModerator: false }],
  ])('%s refuses %j before anything is fetched or charged', async (mode, user) => {
    givenSwitch(mode);
    await expect(enhance(user)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'paused' });
    expectNothingStarted();
  });

  it.each([
    ['disabled', { isModerator: true, tier: 'free' }],
    ['memberOnly', { isModerator: true }],
    ['memberOnly', { isModerator: false, tier: 'gold' }],
    ['enabled', { isModerator: false, tier: 'free' }],
  ])('%s lets %j enhance', async (mode, user) => {
    givenSwitch(mode);
    await expect(enhance(user)).resolves.toEqual({ id: 'workflow' });
    expectEnhanced();
  });

  it.each([{ isModerator: true }, { isModerator: false, tier: 'gold' }])(
    'a switch that cannot be read refuses %j',
    async (user) => {
      // The fallback status reads "enabled" here, so only the unknown state can refuse.
      givenSwitch('enabled', false);
      await expect(enhance(user)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expectNothingStarted();
    }
  );

  it('ONSITE_ENHANCE_ENFORCE_GENERATION_STATUS off: disabled and unknown no longer refuse (the previous behaviour)', async () => {
    setEnv({ ONSITE_ENHANCE_ENFORCE_GENERATION_STATUS: false });
    givenSwitch('disabled', false);
    await expect(enhance({ isModerator: false, tier: 'free' })).resolves.toEqual({
      id: 'workflow',
    });
    expectEnhanced();
  });
});
