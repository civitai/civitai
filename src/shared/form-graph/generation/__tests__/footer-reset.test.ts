import { describe, expect, it } from 'vitest';
import { FOOTER_RESET } from '~/components/form-graph/generation/footer-reset';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { openaiVersionIds } from '~/shared/form-graph/generation/image/openai.graph';
import type { GenerationCtx } from '~/shared/generation/context';

/**
 * Reported by a user, 2026-10: every Reset sent the generator back to the default ecosystem.
 * Reset now clears the active family only, and keeps the ecosystem and workflow.
 */
const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { wildcards: true },
  gateRules: [],
};

function formOnOpenAI() {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow: 'txt2img', ecosystem: 'OpenAI', prompt: 'a cat' });
  store.set({ model: { id: openaiVersionIds['v2.5-sunburst'] } });
  store.set({ quality: 'medium' });
  return store;
}

const read = (store: ReturnType<typeof formOnOpenAI>) => {
  const state = store.getSnapshot().state as Record<string, unknown>;
  return {
    ecosystem: state.ecosystem,
    workflow: state.workflow,
    model: (state.model as { id?: number } | undefined)?.id,
    quality: state.quality,
    prompt: state.prompt,
  };
};

describe('the footer reset', () => {
  it('keeps the ecosystem and workflow', () => {
    const store = formOnOpenAI();
    store.reset(FOOTER_RESET);

    expect(read(store).ecosystem).toBe('OpenAI');
    expect(read(store).workflow).toBe('txt2img');
  });

  it("clears the active family's settings and the prompt", () => {
    const fresh = generationHub.createStore({ ext: EXT });
    fresh.set({ workflow: 'txt2img', ecosystem: 'OpenAI' });
    const defaults = read(fresh);

    const store = formOnOpenAI();
    store.reset(FOOTER_RESET);

    expect(read(store).model).toBe(defaults.model);
    expect(read(store).quality).toBe(defaults.quality);
    expect(read(store).prompt).toBe(defaults.prompt);
    // Guards the defaults above against matching the user's values by coincidence.
    expect(defaults.model).not.toBe(openaiVersionIds['v2.5-sunburst']);
    expect(defaults.quality).not.toBe('medium');
  });

  it("leaves other families' settings alone", () => {
    const store = formOnOpenAI();
    store.set({ ecosystem: 'Illustrious' });
    store.reset(FOOTER_RESET);
    store.set({ ecosystem: 'OpenAI' });

    expect(read(store).model).toBe(openaiVersionIds['v2.5-sunburst']);
    expect(read(store).quality).toBe('medium');
  });
});
