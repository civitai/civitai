import { describe, expect, it } from 'vitest';
import { ecosystemById } from '~/shared/constants/basemodel.constants';
import {
  getEcosystemsForWorkflow,
  getOutputTypeForWorkflow,
  workflowOptions,
} from '~/shared/data-graph/generation/config/workflows';
import { generationHub } from '../hub.graph';
import { resolveCompatibleEcosystem } from '../ecosystem-gates';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const makeStore = () => generationHub.createStore({ ext: EXT });
const state = (store: ReturnType<typeof makeStore>) =>
  store.getSnapshot().state as { workflow?: string; ecosystem?: string; output?: string };

describe('selector coherence rules', () => {
  it('an ecosystem write from an incompatible workflow retargets the workflow (no throw)', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2vid' });
    store.set({ ecosystem: 'Seedance' });
    store.set({ ecosystem: 'Illustrious' }); // the gesture that used to crash the branch
    expect(state(store).ecosystem).toBe('Illustrious');
    expect(state(store).output).toBe('image');
    expect(state(store).workflow).toBe('txt2img');
  });

  it('a stored workflow that fits the new ecosystem is untouched', (ctx) => {
    // a non-default image workflow Illustrious supports, from config
    const illustriousId = [...ecosystemById.entries()].find(
      ([, e]) => e.key === 'Illustrious'
    )?.[0];
    const shared = ['txt2img:hires-fix', 'txt2img:face-fix', 'img2img'].find((w) =>
      getEcosystemsForWorkflow(w).includes(illustriousId!)
    );
    // a visible skip, not a silent pass — re-derive the fixture if this fires
    if (!shared) return ctx.skip('config offers no shared workflow to pin');
    const store = makeStore();
    store.set({ workflow: shared, ecosystem: 'SDXL' });
    store.set({ ecosystem: 'Illustrious' });
    expect(state(store).workflow).toBe(shared);
    expect(state(store).ecosystem).toBe('Illustrious');
  });

  it('a coherent two-key write is applied verbatim', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2vid', ecosystem: 'Seedance' });
    expect(state(store).workflow).toBe('txt2vid');
    expect(state(store).ecosystem).toBe('Seedance');
  });

  it('a same-output workflow switch keeps the DISPLAYED ecosystem, default-derived or not', () => {
    // the field-report case: v1 migration carried only the workflow; Qwen is
    // merely img2img:edit's default — switching to txt2img must keep it
    const store = generationHub.createStore({
      ext: EXT,
      storage: { load: () => ({ workflow: 'img2img:edit' }), save: () => undefined },
    });
    expect(state(store).ecosystem).toBe('Qwen');
    store.set({ workflow: 'txt2img' });
    expect(state(store).workflow).toBe('txt2img');
    expect(state(store).ecosystem).toBe('Qwen');
  });

  it('a cross-output switch does NOT clobber the target bucket memory', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2vid' });
    store.set({ ecosystem: 'Kling' });
    store.set({ workflow: 'txt2img' });
    store.set({ ecosystem: 'Illustrious' });
    store.set({ workflow: 'txt2vid' });
    expect(state(store).ecosystem).toBe('Kling'); // remembered, not the video default
    store.set({ workflow: 'txt2img' });
    expect(state(store).ecosystem).toBe('Illustrious');
  });

  it('a workflow write whose ecosystem no longer fits redirects the ecosystem', (ctx) => {
    const store = makeStore();
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL' });
    // an eco-carrying image workflow that excludes SDXL, found from config
    const restricted = workflowOptions
      .map((w) => w.id)
      .find((w) => {
        if (getOutputTypeForWorkflow(w) !== 'image') return false;
        const ids = getEcosystemsForWorkflow(w);
        return ids.length > 0 && !ids.some((id) => ecosystemById.get(id)?.key === 'SDXL');
      });
    // a visible skip, not a silent pass — re-derive the fixture if this fires
    if (!restricted) return ctx.skip('config offers no SDXL-excluding image workflow to pin');
    store.set({ workflow: restricted });
    const eco = state(store).ecosystem;
    // the rule's invariant: the pair is compatible (overrides included)
    expect(eco).toBeTruthy();
    expect(resolveCompatibleEcosystem(restricted, eco!)).toBe(eco);
  });
});
