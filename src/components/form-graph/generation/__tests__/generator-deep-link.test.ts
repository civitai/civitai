import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { krea3VersionId } from '~/shared/form-graph/generation/image/krea3.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import { generatorDeepLinkFields } from '~/shared/generation/generator-deep-link';
import { applyGenerationData, openWithDeepLinkFields } from '../ingestion';

const makeStore = (flags: GenerationCtx['flags'] = { krea3Ultra: true }) =>
  generationHub.createStore({
    ext: {
      limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
      user: { isMember: true, tier: 'gold' },
      flags,
      gateRules: [],
    } satisfies GenerationCtx,
  });
type Store = ReturnType<typeof makeStore>;
type Payload = Parameters<typeof applyGenerationData>[1];

const state = (store: Store) => store.getSnapshot().state as Record<string, unknown>;

/**
 * Stands in for `generationGraphPanel.open({ type: 'modelVersion' })`: bumps the open sequence
 * at once, then lands the model's data a tick later, as the real fetch does.
 */
function krea3Panel(store: Store) {
  let sequence = 0;
  return {
    sequence: () => sequence,
    open: async () => {
      sequence++;
      await new Promise((resolve) => setTimeout(resolve, 0));
      applyGenerationData(store, {
        runType: 'run',
        params: { ecosystem: 'Krea3', workflow: 'txt2img' },
        resources: [
          {
            id: krea3VersionId,
            model: { type: 'Checkpoint' },
            baseModel: 'Krea 3',
          } as unknown as Payload['resources'][number],
        ],
      });
    },
  };
}

async function openLink(store: Store, query: string, panel = krea3Panel(store)) {
  await openWithDeepLinkFields(
    store,
    panel.open,
    generatorDeepLinkFields(new URLSearchParams(query)),
    panel.sequence
  );
}

describe('generator deep link fields', () => {
  it('sets resolution and thinking mode once the model has loaded', async () => {
    const store = makeStore();
    await openLink(store, 'resolution=2k&thinkingMode=ultra');

    const s = state(store);
    expect(s.ecosystem).toBe('Krea3');
    expect(s.resolution).toBe('2k');
    expect(s.thinkingMode).toBe('ultra');
  });

  it('leaves the model defaults when the link carries no fields', async () => {
    const store = makeStore();
    await openLink(store, 'prompt=a%20cat');

    const s = state(store);
    expect(s.ecosystem).toBe('Krea3');
    expect(s.resolution).toBe('1k');
    expect(s.thinkingMode).toBe('instant');
    expect(s.prompt).not.toBe('a cat');
  });

  it('corrects a value the model does not offer instead of failing', async () => {
    const ultraAt1k = makeStore();
    await openLink(ultraAt1k, 'resolution=1k&thinkingMode=ultra');
    expect(state(ultraAt1k).thinkingMode).toBe('instant');

    const bogus = makeStore();
    await openLink(bogus, 'resolution=8k&thinkingMode=turbo');
    expect(state(bogus).resolution).toBe('1k');
    expect(state(bogus).thinkingMode).toBe('instant');
    // Only the prompt the link leaves to the user stands between the form and Generate.
    const result = bogus.validate();
    expect(result.success ? [] : Object.keys(result.errors)).toEqual(['prompt']);

    const upperCase = makeStore();
    await openLink(upperCase, 'resolution=2K&thinkingMode=ultra');
    expect(state(upperCase).resolution).toBe('2k');
    expect(state(upperCase).thinkingMode).toBe('ultra');
  });

  it('gives Instant to a viewer without Ultra access', async () => {
    const store = makeStore({});
    await openLink(store, 'resolution=2k&thinkingMode=ultra');
    expect(state(store).resolution).toBe('2k');
    expect(state(store).thinkingMode).toBe('instant');
  });

  it('skips the fields when another open replaced this one or the load failed', async () => {
    const replaced = makeStore();
    const panel = krea3Panel(replaced);
    let sequence = 0;
    await openWithDeepLinkFields(
      replaced,
      async () => {
        sequence++;
        await panel.open();
        sequence++; // the user opened something else while the model loaded
      },
      { resolution: '2k' },
      () => sequence
    );
    expect(state(replaced).resolution).toBe('1k');

    const failed = makeStore();
    await openWithDeepLinkFields(
      failed,
      () => Promise.reject(new Error('fetch failed')),
      { resolution: '2k' },
      () => 0
    );
    expect(state(failed).resolution).not.toBe('2k');
  });
});
