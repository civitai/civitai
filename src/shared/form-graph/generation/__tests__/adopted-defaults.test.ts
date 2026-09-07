import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

describe('adopted defaults at generation scale', () => {
  it('the field report: displayed default ecosystem survives a workflow switch', () => {
    const store = generationHub.createStore({
      ext: EXT,
      storage: { load: () => ({ workflow: 'img2img:edit' }), save: () => undefined },
    });
    const s1 = store.getSnapshot().state as Record<string, unknown>;
    expect(s1.ecosystem).toBe('Qwen');
    store.set({ workflow: 'txt2img' });
    const s2 = store.getSnapshot().state as Record<string, unknown>;
    expect(s2.ecosystem).toBe('Qwen'); // sticky via adoption, no rule involved
    // Qwen maps its model PER WORKFLOW (v1's workflow-version swap) — the
    // family's own logic overrides stickiness exactly where the domain says
    expect((s1.model as { id?: number })?.id).toBe(2558804);
    expect((s2.model as { id?: number })?.id).toBe(2552908);
  });

  it('saves stay user-writes-only at generation scale', () => {
    let saved: Record<string, unknown> = {};
    const store = generationHub.createStore({
      ext: EXT,
      storage: { load: () => undefined, save: (r) => void (saved = r) },
    });
    store.set({ prompt: 'a cat' });
    expect(Object.keys(saved).sort()).toEqual(['prompt']);
  });
});
