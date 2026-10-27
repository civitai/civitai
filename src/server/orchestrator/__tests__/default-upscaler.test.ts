import { describe, expect, it } from 'vitest';
import { ECO, ecosystemSettings } from '~/shared/constants/basemodel.constants';
import { createVideoEnhancementStep } from '~/server/orchestrator/video-enhancement/video-enhancement';
import { workflowDefinitions } from '~/server/services/orchestrator/comfy/comfy.types';

// The default upscaler must be the CivitaiOfficial copy of Remacri: the community upload it replaced
// charged its uploader's per-image fee on every upscale that left the picker at its default.
const OFFICIAL_REMACRI_AIR = 'urn:air:other:upscaler:civitai:3022421@3432055';

describe('default upscaler', () => {
  it('is what video enhancement upscales with', async () => {
    const step = await createVideoEnhancementStep({
      sourceUrl: 'https://example.test/video.mp4',
      width: 1920,
      height: 1080,
      params: {},
    } as Parameters<typeof createVideoEnhancementStep>[0]);
    expect(step.input.upscaler?.model).toBe(OFFICIAL_REMACRI_AIR);
  });

  it('is what every comfy workflow loads as its upscale model', () => {
    // Templates carry unquoted mustache placeholders, so they are not JSON until rendered.
    const loaders = workflowDefinitions.flatMap(
      (definition) => definition.template.match(/urn:air:other:upscaler:[^"]+/g) ?? []
    );
    expect(loaders.length).toBeGreaterThan(0);
    expect(new Set(loaders)).toEqual(new Set([OFFICIAL_REMACRI_AIR]));
  });

  it('is the default model of the upscaler ecosystem', () => {
    const settings = ecosystemSettings.find((s) => s.ecosystemId === ECO.Other);
    expect(settings?.defaults?.model?.id).toBe(3432055);
  });
});
