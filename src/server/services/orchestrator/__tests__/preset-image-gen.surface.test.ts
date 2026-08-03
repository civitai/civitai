import { beforeEach, describe, expect, it, vi } from 'vitest';

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
 * 🔴 BEHAVIOURAL proof that the preset generation surface labels ITSELF (issue
 * #3520 fix 2), by actually calling the exported entry points and reading the
 * argument that reaches `buildGenerationContext`.
 *
 * Why this matters: `civitai_generation_model_substitutions_total` is emitted
 * from `validateInput`, which is shared by the on-site generator, the App Blocks
 * bridge and this path, and which cannot tell them apart. Comics/preset volume
 * summed into the App Blocks series would inflate the number that gates the
 * phase-3 policy decision with a population that has nothing to do with it.
 *
 * The companion `generation-surface-wiring.test.ts` guards the POPULATION of call
 * sites; this one proves the value actually flows on a real call.
 */

// Any real registry entry — the surface is a property of the CALL SITE, not of
// the model, so which one is irrelevant as long as it is a genuine config.
const modelConfig = Object.values(PRESET_MODEL_CONFIG)[0];
const user = { id: 42, isModerator: false, tier: 'free' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildGenerationContext.mockResolvedValue({ externalCtx: {}, status: { mode: 'enabled' } });
  mockGenerateFromGraph.mockResolvedValue({ id: 'wf_1' });
  mockWhatIfFromGraph.mockResolvedValue({ cost: { total: 10 }, ready: true });
});

describe('preset image generation declares the `preset` surface', () => {
  it('submitPresetImageGen builds its context with surface `preset`', async () => {
    await submitPresetImageGen({
      prompt: 'a cat',
      aspectRatio: '1:1',
      modelConfig,
      user,
      token: 'tok',
      currencies: [],
      tags: ['comics'],
    });

    expect(mockBuildGenerationContext).toHaveBeenCalledTimes(1);
    // 4th positional argument — asserted by INDEX, not by "contains", so a
    // surface passed in the wrong slot fails instead of passing.
    expect(mockBuildGenerationContext.mock.calls[0][3]).toBe('preset');
    // …and not one of the other two, which is the failure this is really about.
    expect(mockBuildGenerationContext.mock.calls[0][3]).not.toBe('block');
    expect(mockBuildGenerationContext.mock.calls[0][3]).not.toBe('onsite');
  });

  it('whatIfPresetImageGen builds its context with surface `preset` too', async () => {
    // The what-if is a SECOND graph validation for the same user action, so it
    // increments the counter independently. If only the submit path were
    // labelled, half of preset volume would land on whatever surface the default
    // named.
    await whatIfPresetImageGen({
      prompt: 'a cat',
      aspectRatio: '1:1',
      modelConfig,
      user,
      token: 'tok',
      currencies: [],
    });

    expect(mockBuildGenerationContext).toHaveBeenCalledTimes(1);
    expect(mockBuildGenerationContext.mock.calls[0][3]).toBe('preset');
  });
});
