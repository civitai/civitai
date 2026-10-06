import { describe, expect, it } from 'vitest';
import { mapDataToGraphInput } from '../legacy-metadata-mapper';

describe('mapDataToGraphInput — image draft params', () => {
  // The shape prod actually stores for an image draft: the workflow key names it and there is
  // NO `draft` field. Keying on `draft` alone missed every real row.
  const storedImageDraft = {
    prompt: 'x',
    workflow: 'txt2img:draft',
    baseModel: 'Illustrious',
    steps: 8,
    cfgScale: 1,
    sampler: 'Euler',
  };

  it('remixes an SD-family draft back into the draft workflow, keeping its params', () => {
    const out = mapDataToGraphInput(storedImageDraft as never, []) as Record<string, unknown>;
    expect(out).toMatchObject({
      workflow: 'txt2img:draft',
      steps: 8,
      cfgScale: 1,
      sampler: 'Euler',
      prompt: 'x',
    });
  });

  it('maps the newer image:draft key to the draft workflow too', () => {
    const out = mapDataToGraphInput(
      { ...storedImageDraft, workflow: 'image:draft' } as never,
      []
    ) as Record<string, unknown>;
    expect(out).toMatchObject({ workflow: 'txt2img:draft', steps: 8 });
  });

  it('remixes a Flux draft back into the draft workflow', () => {
    const out = mapDataToGraphInput(
      { prompt: 'x', workflow: 'txt2img:draft', baseModel: 'Flux1' } as never,
      []
    ) as Record<string, unknown>;
    expect(out.workflow).toBe('txt2img:draft');
  });

  it('drops the params when an old draft lands outside the draft workflow', () => {
    const out = mapDataToGraphInput(
      { ...storedImageDraft, baseModel: 'Chroma', steps: 4 } as never,
      []
    ) as Record<string, unknown>;
    expect(out.workflow).not.toBe('txt2img:draft');
    expect(out.steps).toBeUndefined();
    expect(out.cfgScale).toBeUndefined();
    expect(out.sampler).toBeUndefined();
  });

  it('drops them for the legacy form shape, which set a draft flag instead', () => {
    const out = mapDataToGraphInput(
      {
        prompt: 'x',
        process: 'txt2img',
        baseModel: 'SD1',
        draft: true,
        steps: 6,
        cfgScale: 1,
        sampler: 'LCM',
      } as never,
      []
    ) as Record<string, unknown>;
    expect(out.steps).toBeUndefined();
    expect(out.cfgScale).toBeUndefined();
    expect(out.sampler).toBeUndefined();
  });

  it('keeps the same params when the image was not a draft', () => {
    const out = mapDataToGraphInput(
      {
        prompt: 'x',
        process: 'txt2img',
        baseModel: 'SDXL',
        steps: 30,
        cfgScale: 7,
        sampler: 'Euler',
      } as never,
      []
    ) as Record<string, unknown>;
    expect(out).toMatchObject({ steps: 30, cfgScale: 7, sampler: 'Euler' });
  });

  // No ecosystem to check against, so the draft key stands and the form's ecosystem decides.
  it('keeps the draft workflow and params when the ecosystem cannot be inferred', () => {
    const { baseModel: _, ...noBase } = storedImageDraft;
    const out = mapDataToGraphInput(noBase as never, []) as Record<string, unknown>;
    expect(out).toMatchObject({ workflow: 'txt2img:draft', steps: 8, cfgScale: 1 });
    expect(out.ecosystem).toBeUndefined();
  });

  it('leaves a video draft alone', () => {
    const out = mapDataToGraphInput(
      { prompt: 'x', workflow: 'txt2vid', draft: true, steps: 20 } as never,
      []
    ) as Record<string, unknown>;
    expect(out.draft).toBe(true);
    expect(out.steps).toBe(20);
  });
});
