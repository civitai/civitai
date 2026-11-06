import { NsfwLevel } from '@civitai/orchestration-client';
import { describe, expect, it } from 'vitest';
import { switchToMatureSourceAlternative } from '~/components/form-graph/generation/useFlux3MatureSource';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import {
  flux3SourceImageUrls,
  hasMatureSource,
} from '~/shared/form-graph/generation/video/flux3-mature-source';
import type { GenerationCtx } from '~/shared/generation/context';
import { flux3VideoVersionIds, minimaxVersionIds } from '~/shared/generation/version-ids';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const FIRST = { url: 'https://example.com/first.jpg', width: 1216, height: 832 };
const LAST = { url: 'https://example.com/last.jpg', width: 1216, height: 832 };

function flux3Store(workflow: string, modelId = flux3VideoVersionIds['v3.0']) {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow, ecosystem: 'Flux3Video', prompt: 'x' });
  store.set({ model: { id: modelId } });
  return store;
}

const sourcesOf = (store: ReturnType<typeof flux3Store>) =>
  flux3SourceImageUrls(store.getSnapshot().state);

const rated = (levels: Record<string, NsfwLevel>) => (url: string) => levels[url];

describe('Flux 3 Video mature source block', () => {
  it('reads first and last frames in image to video', () => {
    const store = flux3Store('img2vid');
    store.set({ images: [FIRST, LAST] });
    expect(sourcesOf(store)).toEqual([FIRST.url, LAST.url]);
  });

  it('reads keyframe images in keyframes to video', () => {
    const store = flux3Store('img2vid:keyframes', flux3VideoVersionIds['v3.0-max']);
    store.set({
      keyframes: [
        { image: FIRST, frameIndex: 0 },
        { image: LAST, frameIndex: 48 },
      ],
    });
    expect(sourcesOf(store)).toEqual([FIRST.url, LAST.url]);
  });

  it('checks nothing for text to video or another ecosystem', () => {
    expect(sourcesOf(flux3Store('txt2vid'))).toEqual([]);

    const h3 = generationHub.createStore({ ext: EXT });
    h3.set({ workflow: 'img2vid', ecosystem: 'MiniMaxH3', prompt: 'x' });
    h3.set({ images: [FIRST] });
    expect(flux3SourceImageUrls(h3.getSnapshot().state)).toEqual([]);
  });

  it.each([NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX])('blocks a %s source in any slot', (level) => {
    const urls = [FIRST.url, LAST.url];
    expect(hasMatureSource(urls, rated({ [LAST.url]: level }))).toBe(true);
  });

  it.each([NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.NA])('lets a %s source through', (level) => {
    expect(hasMatureSource([FIRST.url], rated({ [FIRST.url]: level }))).toBe(false);
  });

  it('lets an unrated source through', () => {
    expect(hasMatureSource([FIRST.url], () => undefined)).toBe(false);
    expect(hasMatureSource([FIRST.url], () => null)).toBe(false);
  });

  it('the switch lands on self-hosted H3, over a hosted build picked earlier, and keeps both frames', () => {
    const store = generationHub.createStore({ ext: EXT });
    store.set({ workflow: 'img2vid', ecosystem: 'MiniMaxH3', prompt: 'x' });
    store.set({ model: { id: minimaxVersionIds.max } });
    store.set({ ecosystem: 'Flux3Video' });
    store.set({ model: { id: flux3VideoVersionIds['v3.0'] } });
    store.set({ images: [FIRST, LAST] });

    switchToMatureSourceAlternative(store);

    const state = store.getSnapshot().state as {
      ecosystem?: string;
      images?: { url: string }[];
    };
    expect(state.ecosystem).toBe('MiniMaxH3');
    expect((store.getField('model')?.value as { id: number }).id).toBe(minimaxVersionIds.comfy);
    expect(state.images?.map((i) => i.url)).toEqual([FIRST.url, LAST.url]);
  });
});
