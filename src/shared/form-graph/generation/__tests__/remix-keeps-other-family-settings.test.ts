import { describe, expect, it } from 'vitest';
import { REMIX_RESET } from '~/components/form-graph/generation/remix-reset';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { openaiVersionIds } from '~/shared/form-graph/generation/image/openai.graph';
import type { GenerationCtx } from '~/shared/generation/context';

/**
 * Reported from the generator queue, 2026-10: a user with OpenAI on v2.5 Sunburst at medium
 * quality applied Hires Fix to an Illustrious image, switched back to OpenAI, and found v2 at
 * high — with no input of their own. The ingestion reset cleared EVERY scope bucket, so the
 * target family was repopulated by the patch while every other family fell back to defaults.
 *
 * These drive the store through the same three steps as `applyRemix`, using the call site own
 * REMIX_RESET rather than restating it, so a drift in the options breaks this too. What they do
 * NOT cover is the hook itself: `useGenerationIngestion` needs a render, so the ORDER of the
 * three calls is still only pinned by the comment beside them.
 */
const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { wildcards: true },
  gateRules: [],
};
const IMAGE = { url: 'https://image.civitai.com/a.png', width: 1536, height: 1024 };

/** A form the user has already set up the way they like it, on OpenAI. */
function formOnOpenAI() {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow: 'txt2img', ecosystem: 'OpenAI', prompt: 'a cat' });
  store.set({ model: { id: openaiVersionIds['v2.5-sunburst'] } });
  store.set({ quality: 'medium' });
  return store;
}

/** The three steps `applyRemix` takes, in order. */
function applyRemixTo(
  store: ReturnType<typeof formOnOpenAI>,
  values: Record<string, unknown>,
  ecosystem: string,
  workflow: string
) {
  store.set({ ecosystem, workflow });
  store.reset(REMIX_RESET);
  store.set(values);
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

describe('a remix keeps the other families settings', () => {
  it('restores the OpenAI version and quality after a round trip through another family', () => {
    const store = formOnOpenAI();

    applyRemixTo(
      store,
      {
        workflow: 'img2img:hires-fix',
        ecosystem: 'Illustrious',
        prompt: 'from the image',
        images: [IMAGE],
      },
      'Illustrious',
      'img2img:hires-fix'
    );
    store.set({ ecosystem: 'OpenAI' });

    // On a revert this reports 2880272 (OpenAI default) and high.
    expect(read(store).model).toBe(openaiVersionIds['v2.5-sunburst']);
    expect(read(store).quality).toBe('medium');
  });

  it('still lands the remix on the target family', () => {
    // Guards the other direction: keeping other families must not stop the patch applying.
    const store = formOnOpenAI();

    applyRemixTo(
      store,
      {
        workflow: 'img2img:hires-fix',
        ecosystem: 'Illustrious',
        prompt: 'from the image',
        images: [IMAGE],
      },
      'Illustrious',
      'img2img:hires-fix'
    );

    expect(read(store).ecosystem).toBe('Illustrious');
    expect(read(store).workflow).toBe('img2img:hires-fix');
    expect(read(store).prompt).toBe('from the image');
  });

  it('keeps the staged discriminators, which the reset would otherwise clear', () => {
    // The trap in the recipe: staging the discriminators makes them ACTIVE addresses, so a
    // scoped reset clears them unless they are excluded, and the ecosystem silently falls back
    // to a default. Asserted against the real options, so dropping either name from
    // REMIX_RESET fails here.
    const store = formOnOpenAI();

    store.set({ ecosystem: 'Illustrious', workflow: 'img2img:hires-fix' });
    store.reset(REMIX_RESET);

    expect(read(store).ecosystem).toBe('Illustrious');
    expect(read(store).workflow).toBe('img2img:hires-fix');
  });
});
