import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

const mockBuildGenerationContext = vi.fn();
const mockGenerateFromGraph = vi.fn();
const mockWhatIfFromGraph = vi.fn();

vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: (...args: unknown[]) => mockBuildGenerationContext(...args),
  generateFromGraph: (...args: unknown[]) => mockGenerateFromGraph(...args),
  whatIfFromGraph: (...args: unknown[]) => mockWhatIfFromGraph(...args),
}));

import {
  PRESET_MODEL_CONFIG,
  submitPresetImageGen,
  whatIfPresetImageGen,
} from '../preset-image-gen.service';

/**
 * Every preset entry point (comics, iterate, remix apps, article reframe, the queued comic-panels
 * job) submits through `submitPresetImageGen`, so this is where the global generation kill switch
 * holds for them: refused as onsite refuses, before anything reaches `generateFromGraph`.
 */

const MESSAGE = 'Generation is paused for maintenance';
const modelConfig = Object.values(PRESET_MODEL_CONFIG)[0];

function submitAs(user: { isModerator: boolean; tier?: string }) {
  return submitPresetImageGen({
    prompt: 'a cat',
    aspectRatio: '1:1',
    modelConfig,
    user: { id: 42, ...user } as never,
    token: 'tok',
    currencies: [],
    tags: ['comics'],
  });
}

function givenSwitch(mode: string) {
  mockBuildGenerationContext.mockResolvedValue({
    externalCtx: {},
    status: { mode, message: MESSAGE },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEnv();
  mockGenerateFromGraph.mockResolvedValue({ id: 'wf_1' });
  mockWhatIfFromGraph.mockResolvedValue({ cost: { total: 7 }, ready: true });
});

describe('submitPresetImageGen obeys the generation kill switch', () => {
  it.each([
    ['disabled', 'a free user', { isModerator: false, tier: 'free' }],
    ['disabled', 'a member', { isModerator: false, tier: 'gold' }],
    ['memberOnly', 'a free user', { isModerator: false, tier: 'free' }],
    ['memberOnly', 'a user with no tier', { isModerator: false }],
  ])('%s refuses %s with the operator message', async (mode, _who, user) => {
    givenSwitch(mode);
    const error = await submitAs(user).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: 'BAD_REQUEST', message: MESSAGE });
    expect(mockGenerateFromGraph).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', 'a moderator', { isModerator: true, tier: 'free' }],
    ['memberOnly', 'a moderator', { isModerator: true, tier: 'free' }],
    ['memberOnly', 'a member', { isModerator: false, tier: 'gold' }],
    ['enabled', 'a free user', { isModerator: false, tier: 'free' }],
  ])('%s lets %s submit', async (mode, _who, user) => {
    givenSwitch(mode);
    await expect(submitAs(user)).resolves.toEqual({ id: 'wf_1' });
    expect(mockGenerateFromGraph).toHaveBeenCalledTimes(1);
  });

  it.each(['disabled', 'memberOnly'])(
    'PRESET_ENFORCE_GENERATION_STATUS off: %s no longer refuses a free user (the previous behaviour)',
    async (mode) => {
      setEnv({ PRESET_ENFORCE_GENERATION_STATUS: false });
      givenSwitch(mode);
      await expect(submitAs({ isModerator: false, tier: 'free' })).resolves.toEqual({ id: 'wf_1' });
      expect(mockGenerateFromGraph).toHaveBeenCalledTimes(1);
    }
  );
});

// As onsite refuses `whatIfFromGraph`: no price for a generation the switch would refuse.
describe('whatIfPresetImageGen obeys the generation kill switch', () => {
  const priceAs = (user: { isModerator: boolean; tier?: string }) =>
    whatIfPresetImageGen({
      aspectRatio: '1:1',
      modelConfig,
      user: { id: 42, ...user } as never,
      token: 'tok',
      currencies: [],
    });

  it.each(['disabled', 'memberOnly'])('%s refuses a free user', async (mode) => {
    givenSwitch(mode);
    await expect(priceAs({ isModerator: false, tier: 'free' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: MESSAGE,
    });
    expect(mockWhatIfFromGraph).not.toHaveBeenCalled();
  });

  it('memberOnly prices for a member', async () => {
    givenSwitch('memberOnly');
    await expect(priceAs({ isModerator: false, tier: 'gold' })).resolves.toEqual({
      cost: 7,
      ready: true,
    });
  });

  it('PRESET_ENFORCE_GENERATION_STATUS off: disabled prices again', async () => {
    setEnv({ PRESET_ENFORCE_GENERATION_STATUS: false });
    givenSwitch('disabled');
    await expect(priceAs({ isModerator: false, tier: 'free' })).resolves.toMatchObject({ cost: 7 });
  });
});
