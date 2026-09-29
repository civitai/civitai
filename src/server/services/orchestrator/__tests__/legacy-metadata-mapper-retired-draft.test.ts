import { describe, expect, it } from 'vitest';
import { mapDataToGraphInput } from '../legacy-metadata-mapper';

describe('mapDataToGraphInput — retired image draft params', () => {
  // The shape prod actually stores for an image draft: the workflow key names it and there is
  // NO `draft` field. Keying the strip on `draft` alone missed every real row.
  const storedImageDraft = {
    prompt: 'x',
    workflow: 'txt2img:draft',
    baseModel: 'Illustrious',
    steps: 8,
    cfgScale: 1,
    sampler: 'Euler',
  };

  it('drops the draft-pinned params so the ecosystem defaults apply', () => {
    const out = mapDataToGraphInput(storedImageDraft as never, []) as Record<string, unknown>;
    expect(out.steps).toBeUndefined();
    expect(out.cfgScale).toBeUndefined();
    expect(out.sampler).toBeUndefined();
    expect(out.prompt).toBe('x');
  });

  it('drops them for the newer image:draft key too', () => {
    const out = mapDataToGraphInput(
      { ...storedImageDraft, workflow: 'image:draft' } as never,
      []
    ) as Record<string, unknown>;
    expect(out.steps).toBeUndefined();
    expect(out.cfgScale).toBeUndefined();
    expect(out.sampler).toBeUndefined();
  });

  it('drops them for the legacy form shape, which set a draft flag instead', () => {
    const out = mapDataToGraphInput(
      {
        prompt: 'x',
        process: 'txt2img',
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
      { prompt: 'x', process: 'txt2img', steps: 30, cfgScale: 7, sampler: 'Euler' } as never,
      []
    ) as Record<string, unknown>;
    expect(out).toMatchObject({ steps: 30, cfgScale: 7, sampler: 'Euler' });
  });

  it('leaves a video draft alone — that node was never retired', () => {
    const out = mapDataToGraphInput(
      { prompt: 'x', workflow: 'txt2vid', draft: true, steps: 20 } as never,
      []
    ) as Record<string, unknown>;
    expect(out.draft).toBe(true);
    expect(out.steps).toBe(20);
  });
});
