import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { buildV1MigrationIntent, migrateV1GenerationStorage } from '../migrate-v1-storage';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 10, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const V1_FIXTURE: Record<string, string> = {
  'generation-graph': JSON.stringify({
    workflow: 'txt2img',
    prompt: 'a fox in the snow',
    negativePrompt: 'blurry',
    quantity: 3,
    seed: 1234,
    snippets: { mode: 'random' },
  }),
  'generation-graph.preferences': JSON.stringify({ outputFormat: 'png', priority: 'high' }),
  'generation-graph.workflow.txt2img:draft': JSON.stringify({ quantity: 8 }),
  'generation-graph.output.image': JSON.stringify({ ecosystem: 'SDXL' }),
  'generation-graph.output.video': JSON.stringify({ ecosystem: 'WanVideo25T2V' }),
  'generation-graph.ecosystem.SDXL': JSON.stringify({
    model: { id: 128713, model: { type: 'Checkpoint' } },
    resources: [{ id: 555, model: { type: 'LORA' } }],
    cfgScale: 7,
    steps: 25,
  }),
};

const read = (fixture: Record<string, string>) => (key: string) => fixture[key] ?? null;

describe('buildV1MigrationIntent', () => {
  it('carries exactly the preserved fields, at the addresses the hub reads', () => {
    const intent = buildV1MigrationIntent(read(V1_FIXTURE));
    expect(intent).toEqual({
      workflow: 'txt2img',
      prompt: 'a fox in the snow',
      negativePrompt: 'blurry',
      quantity: 3,
      outputFormat: 'png',
      priority: 'high',
      'quantity@txt2img:draft': 8,
      'ecosystem@image': 'SDXL',
      'ecosystem@video': 'WanVideo25T2V',
      'model@SDXL': { id: 128713, model: { type: 'Checkpoint' } },
      'resources@SDXL': [{ id: 555, model: { type: 'LORA' } }],
    });
  });

  it('returns undefined when v1 stored nothing', () => {
    expect(buildV1MigrationIntent(() => null)).toBeUndefined();
    expect(buildV1MigrationIntent(read({ 'generation-graph': 'not json{' }))).toBeUndefined();
  });

  it('a grouped ecosystem migrates under its group id', () => {
    const intent = buildV1MigrationIntent(
      read({
        'generation-graph.ecosystem.WanVideo': JSON.stringify({
          model: { id: 999, model: { type: 'Checkpoint' } },
        }),
      })
    );
    expect(intent).toEqual({ 'model@WanVideo': { id: 999, model: { type: 'Checkpoint' } } });
  });

  it('runs once EVER: clearing the record later yields a fresh form, not a replay', () => {
    const backing = new Map<string, string>(Object.entries(V1_FIXTURE));
    const fakeLocalStorage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
    };
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: fakeLocalStorage,
      configurable: true,
    });
    try {
      migrateV1GenerationStorage('form-graph:generation');
      expect(backing.get('form-graph:generation')).toBeTruthy();
      expect(backing.get('form-graph:generation:migrated')).toBe('1');
      backing.delete('form-graph:generation'); // the user clears the form record
      migrateV1GenerationStorage('form-graph:generation');
      expect(backing.get('form-graph:generation')).toBeUndefined(); // fresh, no replay
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
    }
  });

  it('the hub store hydrates the migrated record', () => {
    const intent = buildV1MigrationIntent(read(V1_FIXTURE));
    if (!intent) throw new Error('expected an intent record');
    const store = generationHub.createStore({
      ext: EXT,
      storage: { load: () => intent, save: () => undefined },
    });
    const state = store.getSnapshot().state as Record<string, unknown>;
    expect(state.workflow).toBe('txt2img');
    expect(state.prompt).toBe('a fox in the snow');
    expect(state.negativePrompt).toBe('blurry');
    expect(state.quantity).toBe(3);
    expect(state.outputFormat).toBe('png');
    expect(state.priority).toBe('high');
    expect(state.ecosystem).toBe('SDXL');
  });
});
