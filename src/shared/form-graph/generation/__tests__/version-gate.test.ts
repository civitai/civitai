import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { grokVersionIds } from '~/shared/data-graph/generation/version-ids';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * `checkpointDef`'s `filterVersionGroup` is the only thing hiding a gated model
 * version in this lane, and dropping it breaks no other suite — the parity
 * suites compare the two lanes, so a both-lane break passes them. Grok v2.0 is
 * the live case: it carries a production gate rule and has no feature flag
 * behind it any more.
 */

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const v2Hidden: GenerationCtx = {
  ...EXT,
  gateRules: [
    {
      id: 'hide-grok-v2',
      name: '',
      availableTo: 'moderators',
      presentation: 'hidden',
      ecosystems: [],
      workflows: [],
      modelVersionIds: [grokVersionIds['v2.0']],
    },
  ],
};

const versionIds = (store: ReturnType<typeof generationHub.createStore>) =>
  (store.getField('model')?.meta?.versions?.options ?? []).map((o: { value: number }) => o.value);

const openGrok = (ext: GenerationCtx, modelId: number) => {
  const store = generationHub.createStore({ ext });
  store.set({ workflow: 'txt2img', ecosystem: 'Grok', prompt: 'x' });
  store.set({ model: { id: modelId, model: { type: 'Checkpoint' } } });
  return store;
};

describe('grok v2.0 gate rule (form-graph lane)', () => {
  it('offers v2.0 unless a gate rule hides it', () => {
    expect(versionIds(openGrok(EXT, grokVersionIds['v1.0']))).toContain(grokVersionIds['v2.0']);
    expect(versionIds(openGrok(v2Hidden, grokVersionIds['v1.0']))).not.toContain(
      grokVersionIds['v2.0']
    );
  });

  // Grok is modelLocked, so a hidden id outside the version options clamps back
  // to the ecosystem default — the half of the gate that survives a submit.
  it('clamps a submitted v2.0 id back to the default when hidden', () => {
    expect(openGrok(v2Hidden, grokVersionIds['v2.0']).getField('model')?.value?.id).not.toBe(
      grokVersionIds['v2.0']
    );
    expect(openGrok(EXT, grokVersionIds['v2.0']).getField('model')?.value?.id).toBe(
      grokVersionIds['v2.0']
    );
  });
});
