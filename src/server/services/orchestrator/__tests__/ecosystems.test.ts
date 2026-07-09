import { describe, it, expect } from 'vitest';
import { createEcosystemStepInput } from '../ecosystems';
import type { GenerationHandlerCtx } from '../orchestration-new.service';

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

  it('should override engine to "comfyui" for Flux1 when enhancedCompatibility is true', async () => {
    const data = {
      ecosystem: 'Flux1',
      workflow: 'txt2img',
      model: { id: 789 },
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
