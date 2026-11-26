import { describe, expect, it } from 'vitest';
import { capsGenerationOutput, outputRestrictions } from '../output-restrictions';

describe('outputRestrictions', () => {
  it('caps even when the caller allows mature content', () => {
    expect(outputRestrictions(true, true)).toEqual({
      nsfwLevel: 'pg13',
      allowMatureContent: false,
    });
  });

  it("keeps an uncapped submit's refusal, and never asks for mature content", () => {
    expect(outputRestrictions(false, false)).toEqual({ allowMatureContent: false });
    expect(outputRestrictions(false, undefined)).toEqual({});
    expect(outputRestrictions(false, true)).toEqual({});
  });
});

describe('capsGenerationOutput', () => {
  it('caps a private generation on any workflow', () => {
    expect(
      capsGenerationOutput({
        isPrivateGeneration: true,
        workflow: 'txt2img',
        baseModels: ['SDXL 1.0'],
      })
    ).toBe(true);
  });

  it('caps sfwOnly workflows such as avatars', () => {
    expect(capsGenerationOutput({ workflow: 'img2img:avatar', baseModels: ['SDXL 1.0'] })).toBe(
      true
    );
    expect(capsGenerationOutput({ workflow: 'txt2img', baseModels: ['SDXL 1.0'] })).toBe(false);
  });

  it('caps when any resource is on a base model that restricts generation', () => {
    expect(capsGenerationOutput({ baseModels: ['Ideogram 4.0'] })).toBe(true);
    expect(capsGenerationOutput({ baseModels: ['Nano Banana'] })).toBe(true);
    expect(capsGenerationOutput({ baseModels: ['SDXL 1.0', 'SDXL Turbo'] })).toBe(true);
  });

  it('does not cap resources on unrestricted base models, whatever their ecosystem holds', () => {
    expect(capsGenerationOutput({ baseModels: ['SDXL 1.0'], ecosystem: 'SDXL' })).toBe(false);
    expect(capsGenerationOutput({ baseModels: ['Illustrious', undefined] })).toBe(false);
  });

  it('caps by ecosystem only when every base in it restricts', () => {
    expect(capsGenerationOutput({ baseModels: [], ecosystem: 'Ideogram' })).toBe(true);
    expect(capsGenerationOutput({ baseModels: [], ecosystem: 'SDXL' })).toBe(false);
    expect(capsGenerationOutput({ baseModels: [] })).toBe(false);
  });

  it('caps a restricted ecosystem whatever base models its resources carry', () => {
    expect(capsGenerationOutput({ baseModels: ['SDXL 1.0'], ecosystem: 'Fibo2' })).toBe(true);
  });

  it('caps a base-model string that differs from the record only in case', () => {
    expect(capsGenerationOutput({ baseModels: ['FIBO 2.0'] })).toBe(true);
  });
});
