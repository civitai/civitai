import { describe, expect, it } from 'vitest';
import { capsGenerationOutput, workflowOutputRestrictions } from '../output-restrictions';

describe('workflowOutputRestrictions', () => {
  it('caps avatar workflows even when the caller allows mature content', () => {
    expect(
      workflowOutputRestrictions({
        workflow: 'img2img:avatar',
        isPrivateGeneration: false,
        capOutput: false,
        allowMatureContent: true,
      })
    ).toEqual({ nsfwLevel: 'pg13', allowMatureContent: false });
  });

  it('caps private generation on any workflow', () => {
    expect(
      workflowOutputRestrictions({
        workflow: 'txt2img',
        isPrivateGeneration: true,
        capOutput: false,
        allowMatureContent: true,
      })
    ).toEqual({ nsfwLevel: 'pg13', allowMatureContent: false });
  });

  it("leaves other workflows to the caller's choice", () => {
    expect(
      workflowOutputRestrictions({
        workflow: 'txt2img',
        isPrivateGeneration: false,
        capOutput: false,
        allowMatureContent: true,
      })
    ).toEqual({ nsfwLevel: undefined, allowMatureContent: true });
  });

  it('caps a base model that restricts mature generation', () => {
    expect(
      workflowOutputRestrictions({
        workflow: 'txt2img',
        isPrivateGeneration: false,
        capOutput: true,
        allowMatureContent: true,
      })
    ).toEqual({ nsfwLevel: 'pg13', allowMatureContent: false });
  });
});

describe('capsGenerationOutput', () => {
  it('caps when any resource is on a base model that restricts generation', () => {
    expect(capsGenerationOutput({ baseModels: ['Ideogram 4.0'] })).toBe(true);
    expect(capsGenerationOutput({ baseModels: ['Nano Banana'] })).toBe(true);
    expect(capsGenerationOutput({ baseModels: ['SDXL 1.0', 'SDXL Turbo'] })).toBe(true);
  });

  it('does not cap resources on unrestricted base models, whatever their ecosystem holds', () => {
    expect(capsGenerationOutput({ baseModels: ['SDXL 1.0'], ecosystem: 'SDXL' })).toBe(false);
    expect(capsGenerationOutput({ baseModels: ['Illustrious', undefined] })).toBe(false);
  });

  it('decides a submit with no resources by its ecosystem, only when every base restricts', () => {
    expect(capsGenerationOutput({ baseModels: [], ecosystem: 'Ideogram' })).toBe(true);
    expect(capsGenerationOutput({ baseModels: [], ecosystem: 'SDXL' })).toBe(false);
    expect(capsGenerationOutput({ baseModels: [] })).toBe(false);
  });
});
