import { describe, it, expect, vi } from 'vitest';

import { createEcosystemStepInput } from '../ecosystems';
import { createFormGraphStepInput } from '../form-graph';
import { fluxProAirId, fluxUltraAirId } from '~/shared/constants/generation.constants';
import type { GenerationHandlerCtx } from '../orchestration-new.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

describe('createEcosystemStepInput - Enhanced Compatibility', () => {
  const mockAirs = {
    getOrThrow: (id: number) => {
      if (id === 123) return 'urn:air:sdxl:checkpoint:123';
      if (id === 456) return 'urn:air:sdxl:lora:456';
      if (id === 789) return 'urn:air:flux:checkpoint:789';
      throw new Error(`AIR not found for ${id}`);
    },
  };

  const mockCtx: GenerationHandlerCtx = {
    airs: mockAirs as any,
    user: { id: 1, isModerator: false },
    baseStepIndex: 0,
  };

  it('should override engine to "comfyui" for single-step SDXL when enhancedCompatibility is true', async () => {
    const data = {
      ecosystem: 'SDXL',
      workflow: 'txt2img',
      model: { id: 123 },
      prompt: 'a cat',
      aspectRatio: { width: 1024, height: 1024 },
      enhancedCompatibility: true,
    } as any;

    const steps = await createEcosystemStepInput(data, mockCtx);

    const textToImageStep = steps.find((step) => step.$type === 'textToImage');
    expect(textToImageStep).toBeDefined();
    expect((textToImageStep as any).input.engine).toBe('comfyui');
  });

  it('should override engine to "comfyui" for multi-step SDXL (ControlNet) when enhancedCompatibility is true', async () => {
    const data = {
      ecosystem: 'SDXL',
      workflow: 'txt2img',
      model: { id: 123 },
      prompt: 'a cat',
      aspectRatio: { width: 1024, height: 1024 },
      enhancedCompatibility: true,
      controlNets: [
        {
          mode: 'auto',
          preprocessor: 'canny',
          image: { url: 'https://example.com/image.png' },
          weight: 1.0,
          startStep: 0,
          endStep: 1,
        },
      ],
    } as any;

    const steps = await createEcosystemStepInput(data, mockCtx);

    // Verify there is a preprocess step prepended
    const preprocessStep = steps.find((step) => step.$type === 'preprocessImage');
    expect(preprocessStep).toBeDefined();

    // Verify the engine is overridden to 'comfyui' on the textToImage step
    const textToImageStep = steps.find((step) => step.$type === 'textToImage');
    expect(textToImageStep).toBeDefined();
    expect((textToImageStep as any).input.engine).toBe('comfyui');
  });

  // Repointed from Flux1, which no longer has the toggle: it is comfyui either way, so the case
  // passed without exercising the flag. SD1 is the other ecosystem that still has one.
  it('should override engine to "comfyui" for SD1 when enhancedCompatibility is true', async () => {
    const data = {
      ecosystem: 'SD1',
      workflow: 'txt2img',
      model: { id: 123 },
      prompt: 'a cat',
      aspectRatio: { width: 1024, height: 1024 },
      enhancedCompatibility: true,
    } as any;

    const steps = await createEcosystemStepInput(data, mockCtx);

    const textToImageStep = steps.find((step) => step.$type === 'textToImage');
    expect(textToImageStep).toBeDefined();
    expect((textToImageStep as any).input.engine).toBe('comfyui');
  });

  it('should NOT override engine to "comfyui" when enhancedCompatibility is false', async () => {
    const data = {
      ecosystem: 'SDXL',
      workflow: 'txt2img',
      model: { id: 123 },
      prompt: 'a cat',
      aspectRatio: { width: 1024, height: 1024 },
      enhancedCompatibility: false,
    } as any;

    const steps = await createEcosystemStepInput(data, mockCtx);

    const textToImageStep = steps.find((step) => step.$type === 'textToImage');
    expect(textToImageStep).toBeDefined();
    expect((textToImageStep as any).input.engine).toBeUndefined();
  });
});

/**
 * Both submission lanes derive the engine from `usesComfyEngine`. Asserting them
 * side by side is what catches one lane being updated and the other not — the
 * failure the differential suite cannot see, because it compares the two lanes
 * to each other rather than to the rule.
 */
describe.each([
  ['data-graph', createEcosystemStepInput],
  ['form-graph', createFormGraphStepInput],
] as const)('%s dispatcher — engine defaults after the sdcpp/comfy split', (_lane, dispatch) => {
  const mockCtx = {
    airs: {
      getOrThrow: (id: number) => `urn:air:test:checkpoint:${id}`,
    },
    user: { id: 1, isModerator: false },
    baseStepIndex: 0,
  } as unknown as GenerationHandlerCtx;

  const base = {
    workflow: 'txt2img',
    prompt: 'a cat',
    aspectRatio: { width: 1024, height: 1024 },
  };

  function engineOf(steps: Awaited<ReturnType<typeof dispatch>>) {
    const step = steps.find((s) => s.$type === 'textToImage');
    expect(step).toBeDefined();
    return (step as { input: { engine?: string } }).input.engine;
  }

  // The five ecosystems that lost the toggle. Without the dispatcher change each
  // of these falls through to sdcpp, so a revert fails here rather than silently
  // re-routing every Pony and Flux generation.
  it.each(['Pony', 'Illustrious', 'NoobAI', 'Flux1', 'FluxKrea'])(
    '%s runs comfyui with no enhancedCompatibility flag at all',
    async (ecosystem) => {
      const steps = await dispatch({ ...base, ecosystem, model: { id: 123 } } as never, mockCtx);
      expect(engineOf(steps)).toBe('comfyui');
    }
  );

  it('Flux1 runs comfyui even when enhancedCompatibility is explicitly false', async () => {
    const steps = await dispatch(
      { ...base, ecosystem: 'Flux1', model: { id: 123 }, enhancedCompatibility: false } as never,
      mockCtx
    );
    expect(engineOf(steps)).toBe('comfyui');
  });

  // Flux Ultra and Flux Pro are textToImage steps INSIDE comfy-only Flux1, carrying their own
  // engine. They are the case a blanket per-ecosystem override breaks. Asserting the exact value
  // rather than `not.toBe('comfyui')` — the negative also passes when the engine is unset for some
  // unrelated reason, which is how dropping one of the two ids from the exclusion list stayed green.
  it.each([fluxUltraAirId, fluxProAirId])(
    'model %i keeps its own engine inside Flux1',
    async (id) => {
      const steps = await dispatch(
        { ...base, ecosystem: 'Flux1', model: { id } } as never,
        mockCtx
      );
      expect(engineOf(steps)).toBeUndefined();
    }
  );

  it.each([
    [undefined, undefined],
    [false, undefined],
    [true, 'comfyui'],
  ])('SDXL with enhancedCompatibility=%s runs %s', async (flag, expected) => {
    const steps = await dispatch(
      { ...base, ecosystem: 'SDXL', model: { id: 123 }, enhancedCompatibility: flag } as never,
      mockCtx
    );
    expect(engineOf(steps)).toBe(expected);
  });
});
