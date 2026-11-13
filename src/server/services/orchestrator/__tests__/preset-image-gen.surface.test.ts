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
  aspectRatioDimensions,
  type GenerationResolution,
} from '~/shared/constants/generation.constants';
import { PRESET_MODEL_GRAPH_SIZES } from '~/shared/generation/preset-sizes';
import {
  buildPresetGraphInput,
  PRESET_MODEL_CONFIG,
  pickAspectRatioSize,
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

describe('pickAspectRatioSize', () => {
  const sizes = [
    { label: '2:3', value: '2:3', width: 832, height: 1216 },
    { label: '1:1', value: '1:1', width: 1024, height: 1024 },
    { label: '3:2', value: '3:2', width: 1216, height: 832 },
  ];

  it.each([
    ['a listed label', '1:1', '1:1'],
    ['a landscape ratio the model lacks, to its closest', '16:9', '3:2'],
    ['a portrait ratio the model lacks, to its closest', '3:4', '2:3'],
  ])('resolves %s', (_, asked, expected) => {
    expect(pickAspectRatioSize(asked, sizes).label).toBe(expected);
  });

  it.each(['Landscape', '1:2:3'])("falls to 1:1, the graph's default, for '%s'", (label) => {
    expect(pickAspectRatioSize(label, sizes).label).toBe('1:1');
  });
});

describe('preset resolution', () => {
  it.each(['Seedream', 'SeedreamLite'])(
    '%s asks the graph for 2K on submit and what-if',
    async (key) => {
      const args = {
        prompt: 'a cat',
        aspectRatio: '1:1',
        modelConfig: PRESET_MODEL_CONFIG[key],
        user,
        token: 'tok',
        currencies: [],
      };
      await submitPresetImageGen({ ...args, tags: ['comics'] });
      await whatIfPresetImageGen(args);
      expect(mockGenerateFromGraph.mock.calls[0][0].input).toMatchObject({ resolution: '2K' });
      expect(mockWhatIfFromGraph.mock.calls[0][0].input).toMatchObject({ resolution: '2K' });
    }
  );

  // A registry entry that sends a resolution lists its sizes at that resolution, or the record
  // and the image disagree.
  it.each(Object.entries(PRESET_MODEL_CONFIG).filter(([, c]) => c.resolution))(
    '%s lists its sizes at the resolution it sends',
    (_, config) => {
      const square = config.sizes.find((s) => s.value === '1:1');
      expect(square).toMatchObject(
        aspectRatioDimensions[config.resolution as GenerationResolution]['1:1']
      );
    }
  );

  it('a preset that sets no resolution leaves the graph to its default', () => {
    const input = buildPresetGraphInput({
      aspectRatio: '1:1',
      quantity: 1,
      ecosystem: 'NanoBanana',
      versionId: 1,
    });
    expect(input).not.toHaveProperty('resolution');
  });
});

// The record is made against the graph's whole list (the picker's subset would record a ratio the
// picker never offered as its neighbour), and every entry must resolve to itself.
describe('preset size tables', () => {
  it.each(Object.entries(PRESET_MODEL_CONFIG))(
    '%s records against its graph list, resolving each label to itself and a non-ratio label to 1:1',
    (key, config) => {
      expect(config.sizes).toBe(
        PRESET_MODEL_GRAPH_SIZES[key as keyof typeof PRESET_MODEL_GRAPH_SIZES]
      );
      for (const size of config.sizes) {
        expect(pickAspectRatioSize(size.label, config.sizes)).toBe(size);
      }
      expect(pickAspectRatioSize('Landscape', config.sizes).label).toBe('1:1');
    }
  );
});
