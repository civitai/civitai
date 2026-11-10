import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getResourceData: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: () => h.getResourceData(),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: vi.fn(async () => null),
}));

import { assertNoRestrictedBaseModels } from '~/server/services/blocks/app-base-model-licence';
import { assertViewerEntitledToInlineResources } from '~/server/services/blocks/inline-comfy.service';

const VIEWER = { id: 7, isModerator: false };
const hfAir = (repo: string) =>
  `urn:air:flux2:diffusion_model:huggingface:${repo}@main/model.safetensors`;

beforeEach(() => {
  h.getResourceData.mockReset();
  h.getResourceData.mockResolvedValue([]);
});

describe('assertNoRestrictedBaseModels', () => {
  it('refuses a restricted base model among allowed ones', () => {
    expect(() =>
      assertNoRestrictedBaseModels({ baseModels: ['SDXL 1.0', null, 'Flux.2 Klein 9B'] })
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it.each([
    ['black-forest-labs/FLUX.2-klein-9b-kv-fp8'],
    ['Black-Forest-Labs/FLUX.2-dev'],
    ['black-forest-labs/FLUX.1-Kontext-dev'],
    ['black-forest-labs/flux.1-fill-dev'],
  ])('refuses a resource from %s', (repo) => {
    expect(() => assertNoRestrictedBaseModels({ airs: [hfAir(repo)] })).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' })
    );
  });

  it.each([
    [
      'urn:air:flux2:diffusion_model:huggingface:black-forest-labs/FLUX.2-klein-9B/model.safetensors',
    ],
    [
      'urn:air:flux2:diffusion_model:huggingface:black-forest-labs/FLUX.2-dev/sub/dir/model.safetensors',
    ],
    ['urn:air:flux2:diffusion_model:huggingface:black-forest-labs/FLUX.2-dev'],
  ])('refuses a listed repo named without a version: %s', (air) => {
    expect(() => assertNoRestrictedBaseModels({ airs: [air] })).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' })
    );
  });

  it('allows unrestricted models and repos', () => {
    expect(() =>
      assertNoRestrictedBaseModels({
        baseModels: ['Flux.1 S', 'Flux.3 Klein', 'Ideogram 4.5', undefined],
        airs: [
          hfAir('black-forest-labs/FLUX.1-schnell'),
          hfAir('Comfy-Org/Z-Image-Turbo'),
          'urn:air:sdxl:lora:civitai:118025@136251',
        ],
      })
    ).not.toThrow();
  });
});

describe('inline workflow resources', () => {
  it('refuses a restricted Hugging Face resource', async () => {
    await expect(
      assertViewerEntitledToInlineResources({
        airs: [hfAir('black-forest-labs/FLUX.2-klein-9b')],
        user: VIEWER,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a Civitai resource on a restricted base model', async () => {
    h.getResourceData.mockResolvedValue([
      { id: 136251, baseModel: 'Flux.2 D', canGenerate: true, availability: 'Public' },
    ]);
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:flux2:lora:civitai:118025@136251'],
        user: VIEWER,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
