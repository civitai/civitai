import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';
import { outputResetPredicate } from '../reset';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * The per-output reset must be scoped: resetting the image form clears image
 * buckets and the globals, and leaves other outputs' stored settings intact —
 * v1's `clearStorageForOutput` semantics, on `store.prune`. Exercised through
 * the REAL hub store so the addresses are the ones production writes.
 */

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

function makeStore() {
  return generationHub.createStore({ ext: EXT });
}

describe('outputResetPredicate', () => {
  it('clears image buckets and globals; video and audio buckets survive', () => {
    const store = makeStore();
    // image-side edits: a family bucket (SDXL) + the image ecosystem selection
    store.set({ ecosystem: 'SDXL', steps: 33, prompt: 'a cat' });
    // video-side edits land in video buckets
    store.set({ workflow: 'txt2vid', ecosystem: 'LTXV23' });
    store.set({ cfgScale: 4.5 });
    // back to image so the reset happens from the image form
    store.set({ workflow: 'txt2img' });

    const before = store.getIntent();
    const videoAddresses = Object.keys(before).filter(
      (a) => a.includes('@LTXV23') || a === 'ecosystem@video'
    );
    expect(videoAddresses.length, 'setup must have written video buckets').toBeGreaterThan(0);
    expect(Object.keys(before)).toContain('ecosystem@image');

    store.prune(outputResetPredicate('image'));

    const after = store.getIntent();
    // image bucket + selection + globals gone
    expect(Object.keys(after).filter((a) => a.includes('@SDXL'))).toEqual([]);
    expect(Object.keys(after)).not.toContain('ecosystem@image');
    expect(Object.keys(after)).not.toContain('prompt');
    // video buckets untouched
    for (const address of videoAddresses) {
      expect(after, `video bucket ${address} must survive an image reset`).toHaveProperty([
        address,
      ]);
    }
    // and the live state fell back to defaults
    const state = store.getSnapshot().state as { steps?: number; prompt?: string };
    expect(state.prompt).toBe('');
  });

  it('a video reset clears workflow-scoped and family buckets, not image ones', () => {
    const store = makeStore();
    store.set({ ecosystem: 'SDXL', steps: 33 });
    store.set({ workflow: 'img2vid', ecosystem: 'LTXV23' });
    store.set({ images: [{ url: 'https://example.com/a.png', width: 64, height: 64 }] });

    const before = Object.keys(store.getIntent());
    expect(before.some((a) => a.endsWith('@img2vid'))).toBe(true);

    store.prune(outputResetPredicate('video'));

    const after = Object.keys(store.getIntent());
    expect(after.some((a) => a.endsWith('@img2vid'))).toBe(false);
    expect(after.some((a) => a.includes('@LTXV23'))).toBe(false);
    expect(after).not.toContain('ecosystem@video');
    // image family bucket + selection survive
    expect(after.some((a) => a.includes('@SDXL'))).toBe(true);
    expect(after).toContain('ecosystem@image');
  });

  it('excluded keys survive whatever their bucket', () => {
    const store = makeStore();
    store.set({ outputFormat: 'png', priority: 'high', steps: 33 });

    const before = Object.keys(store.getIntent());
    const preferenceAddresses = before.filter(
      (a) =>
        a === 'outputFormat' ||
        a.startsWith('outputFormat@') ||
        a === 'priority' ||
        a.startsWith('priority@')
    );
    expect(preferenceAddresses.length).toBeGreaterThan(0);

    store.prune(outputResetPredicate('image', { exclude: ['outputFormat', 'priority'] }));

    const after = Object.keys(store.getIntent());
    for (const address of preferenceAddresses) {
      expect(after, `${address} is an output preference and must survive reset`).toContain(address);
    }
  });

  it('a shared family bucket (Grok serves image AND video) clears on either reset', () => {
    // pins the documented wrinkle so a future split is a conscious decision
    expect(outputResetPredicate('image')('resolution@Grok')).toBe(true);
    expect(outputResetPredicate('video')('resolution@Grok')).toBe(true);
    expect(outputResetPredicate('audio')('resolution@Grok')).toBe(false);
  });
});
