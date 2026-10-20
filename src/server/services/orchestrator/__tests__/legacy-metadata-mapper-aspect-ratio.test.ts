import { describe, expect, it } from 'vitest';
import { REMIX_RESET } from '~/components/form-graph/generation/remix-reset';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import { mapDataToGraphInput } from '../legacy-metadata-mapper';

// The shape the current generator writes into image meta: the graph's own aspect ratio object,
// and no top-level width/height. The metadata-read path passes `width: 0, height: 0` beside it.
const storedMeta = {
  prompt: 'x',
  workflow: 'txt2img:hires-fix',
  ecosystem: 'Illustrious',
  steps: 25,
  cfgScale: 2.5,
  sampler: 'DDIM',
  aspectRatio: { value: '2:3', width: 832, height: 1216 },
};

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { wildcards: true },
  gateRules: [],
};

/** Lands mapped params in a form the way a remix does, and reads the aspect ratio back. */
function remixedAspectRatio(params: Record<string, unknown>) {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ ecosystem: params.ecosystem, workflow: params.workflow });
  store.reset(REMIX_RESET);
  store.set(params);
  return (store.getSnapshot().state as { aspectRatio?: unknown }).aspectRatio;
}

describe('mapDataToGraphInput — aspect ratio', () => {
  it('reads the size from a stored aspect ratio object when there are no top-level dims', () => {
    const out = mapDataToGraphInput({ ...storedMeta, width: 0, height: 0 } as never, []);

    expect(out.aspectRatio).toEqual({ value: '2:3', width: 832, height: 1216 });
  });

  it('remixes that meta at its own ratio, not the 1:1 default', () => {
    const out = mapDataToGraphInput({ ...storedMeta, width: 0, height: 0 } as never, []);

    expect(remixedAspectRatio(out)).toEqual({ value: '2:3', width: 832, height: 1216 });
  });

  it('takes the label, not the whole object, when top-level dims are present too', () => {
    const out = mapDataToGraphInput({ ...storedMeta, width: 832, height: 1216 } as never, []);

    expect(out.aspectRatio).toEqual({ value: '2:3', width: 832, height: 1216 });
  });

  it('prefers the top-level dims over the object’s, as the image row is the real size', () => {
    const out = mapDataToGraphInput({ ...storedMeta, width: 1664, height: 2432 } as never, []);

    expect(out.aspectRatio).toEqual({ value: '2:3', width: 1664, height: 2432 });
  });

  it('still builds the ratio from top-level dims alone, as older meta has them', () => {
    const { aspectRatio: _, ...older } = storedMeta;
    const out = mapDataToGraphInput({ ...older, width: 832, height: 1216 } as never, []);

    expect(out.aspectRatio).toEqual({ value: '832:1216', width: 832, height: 1216 });
  });

  it('keeps a string label beside top-level dims', () => {
    const out = mapDataToGraphInput(
      { ...storedMeta, aspectRatio: '2:3', width: 832, height: 1216 } as never,
      []
    );

    expect(out.aspectRatio).toEqual({ value: '2:3', width: 832, height: 1216 });
  });

  it('leaves the ratio out when nothing names a size', () => {
    const { aspectRatio: _, ...older } = storedMeta;
    const out = mapDataToGraphInput({ ...older, width: 0, height: 0 } as never, []);

    expect(out.aspectRatio).toBeUndefined();
  });
});
