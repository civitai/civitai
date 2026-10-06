import { describe, it, expect, vi } from 'vitest';

import { createFormGraphStepInput } from '../form-graph';
import { fluxProAirId, fluxUltraAirId } from '~/shared/constants/generation.constants';
import type { GenerationHandlerCtx } from '../orchestration-new.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

describe('createFormGraphStepInput — enhanced compatibility', () => {
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

  it('should name the comfy engine for single-step SDXL when enhancedCompatibility is true', async () => {
    const data = {
      ecosystem: 'SDXL',
      workflow: 'txt2img',
      model: { id: 123 },
      prompt: 'a cat',
      aspectRatio: { width: 1024, height: 1024 },
      enhancedCompatibility: true,
    } as any;

    const steps = await createFormGraphStepInput(data, mockCtx);

    const genStep = steps.find((step) => step.$type === 'imageGen');
    expect(genStep).toBeDefined();
    expect((genStep as any).input.engine).toBe('comfy');
  });

  it('should name the comfy engine for multi-step SDXL (ControlNet) when enhancedCompatibility is true', async () => {
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

    const steps = await createFormGraphStepInput(data, mockCtx);

    // Verify there is a preprocess step prepended
    const preprocessStep = steps.find((step) => step.$type === 'preprocessImage');
    expect(preprocessStep).toBeDefined();

    const genStep = steps.find((step) => step.$type === 'imageGen');
    expect(genStep).toBeDefined();
    expect((genStep as any).input.engine).toBe('comfy');
  });

  it('should name the comfy engine for SD1 when enhancedCompatibility is true', async () => {
    const data = {
      ecosystem: 'SD1',
      workflow: 'txt2img',
      model: { id: 123 },
      prompt: 'a cat',
      aspectRatio: { width: 1024, height: 1024 },
      enhancedCompatibility: true,
    } as any;

    const steps = await createFormGraphStepInput(data, mockCtx);

    const genStep = steps.find((step) => step.$type === 'imageGen');
    expect(genStep).toBeDefined();
    expect((genStep as any).input.engine).toBe('comfy');
  });

  it('should name the sdcpp engine when enhancedCompatibility is false', async () => {
    const data = {
      ecosystem: 'SDXL',
      workflow: 'txt2img',
      model: { id: 123 },
      prompt: 'a cat',
      aspectRatio: { width: 1024, height: 1024 },
      enhancedCompatibility: false,
    } as any;

    const steps = await createFormGraphStepInput(data, mockCtx);

    const genStep = steps.find((step) => step.$type === 'imageGen');
    expect(genStep).toBeDefined();
    expect((genStep as any).input.engine).toBe('sdcpp');
  });
});

/**
 * Asserts comfy's field names (`sampler`/`scheduler`), not just the engine: an sdcpp-shaped
 * payload (`sampleMethod`/`schedule`) under engine 'comfy' silently drops the sampler, and the
 * handlers' casts hide it from typecheck.
 */
describe('dispatcher — imageGen ecosystems run on comfy', () => {
  const dispatch = createFormGraphStepInput;

  const mockCtx = {
    airs: { getOrThrow: (id: number) => `urn:air:test:checkpoint:${id}` },
    user: { id: 1, isModerator: false },
    baseStepIndex: 0,
  } as unknown as GenerationHandlerCtx;

  const base = {
    workflow: 'txt2img',
    prompt: 'a cat',
    aspectRatio: { width: 1024, height: 1024 },
    model: { id: 123 },
  };

  function imageGenInput(steps: Awaited<ReturnType<typeof dispatch>>) {
    const step = steps.find((s) => s.$type === 'imageGen');
    expect(step).toBeDefined();
    return (step as { input: Record<string, unknown> }).input;
  }

  // zImageMode 'base': the form-graph lane only forwards sampler/scheduler in base mode.
  it.each(['ZImageTurbo', 'ZImageBase'])(
    '%s submits comfy with comfy field names',
    async (ecosystem) => {
      const input = imageGenInput(
        await dispatch(
          { ...base, ecosystem, zImageMode: 'base', sampler: 'heun', scheduler: 'simple' } as never,
          mockCtx
        )
      );
      expect(input.engine).toBe('comfy');
      expect(input).toMatchObject({ sampler: 'heun', scheduler: 'simple' });
      expect(input).not.toHaveProperty('sampleMethod');
      expect(input).not.toHaveProperty('schedule');
    }
  );

  it('Qwen submits comfy', async () => {
    const input = imageGenInput(await dispatch({ ...base, ecosystem: 'Qwen' } as never, mockCtx));
    expect(input.engine).toBe('comfy');
  });
});

describe('dispatcher — engine defaults after the sdcpp/comfy split', () => {
  const dispatch = createFormGraphStepInput;

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
    const step = steps.find((s) => s.$type === 'imageGen');
    expect(step).toBeDefined();
    return (step as { input: { engine?: string } }).input.engine;
  }

  // Comfy-only ecosystems: no toggle, and falling through to sdcpp would silently re-route them.
  it.each(['Flux1', 'FluxKrea'])(
    '%s runs comfy with no enhancedCompatibility flag at all',
    async (ecosystem) => {
      const steps = await dispatch({ ...base, ecosystem, model: { id: 123 } } as never, mockCtx);
      expect(engineOf(steps)).toBe('comfy');
    }
  );

  it('Flux1 runs comfy even when enhancedCompatibility is explicitly false', async () => {
    const steps = await dispatch(
      { ...base, ecosystem: 'Flux1', model: { id: 123 }, enhancedCompatibility: false } as never,
      mockCtx
    );
    expect(engineOf(steps)).toBe('comfy');
  });

  // The handler reads `fluxMode`; it does not re-derive one from `model.id`, so a hand-built
  // input naming a pro AIR still takes standard comfy Flux1. The GRAPH computes fluxMode from
  // the model, so production reaches the pro endpoint — this pins the handler, not the product.
  it.each([fluxUltraAirId, fluxProAirId])(
    'Flux1 AIR id %i takes comfy with no fluxMode',
    async (id) => {
      const steps = await dispatch(
        { ...base, ecosystem: 'Flux1', model: { id } } as never,
        mockCtx
      );
      expect(engineOf(steps)).toBe('comfy');
    }
  );

  describe.each(['SDXL', 'Pony', 'Illustrious', 'NoobAI'])('%s', (ecosystem) => {
    it.each([
      [undefined, 'sdcpp'],
      [false, 'sdcpp'],
      [true, 'comfy'],
    ])('with enhancedCompatibility=%s runs %s', async (flag, expected) => {
      const steps = await dispatch(
        { ...base, ecosystem, model: { id: 123 }, enhancedCompatibility: flag } as never,
        mockCtx
      );
      expect(engineOf(steps)).toBe(expected);
    });
  });
});
