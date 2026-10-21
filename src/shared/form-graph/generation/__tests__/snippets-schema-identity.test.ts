import { describe, expect, it, vi } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { wildcards: true },
  gateRules: [],
};

describe('snippets field', () => {
  it('keeps one schema identity while the user types', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = generationHub.createStore({ ext: EXT });
      store.set({ workflow: 'txt2img', ecosystem: 'SDXL' });
      for (const prompt of ['a', 'a c', 'a ca', 'a cat', 'a cat!']) store.set({ prompt });

      expect(warn.mock.calls.filter(([msg]) => String(msg).includes('snippets'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
