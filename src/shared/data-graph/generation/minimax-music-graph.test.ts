import { describe, expect, it } from 'vitest';
import { generationGraph } from './generation-graph';
import {
  MINIMAX_MUSIC_DEFAULT_DURATION,
  MINIMAX_MUSIC_MAX_DURATION,
  minimaxMusicVersionIds,
} from './minimax-music-graph';
import { workflowConfigs } from './config/workflows';
import { ECO, isBaseModelGenerationSupported } from '@civitai/shared/basemodel.constants';
import type { GenerationCtx } from './context';

const ext: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  gateRules: [],
};

function init(values?: Record<string, unknown>) {
  const graph = generationGraph as any;
  graph.init(
    {
      workflow: 'txt2music',
      ecosystem: 'MiniMaxMusic3',
      model: {
        id: minimaxMusicVersionIds['v3.0'],
        baseModel: 'MiniMax Music 3',
        model: { type: 'Checkpoint' },
      },
      ...values,
    },
    ext
  );
  return graph;
}

// Reaching the graph at all depends on the ecosystem being listed on the one
// audio workflow. Without this the form offers ACE only and every assertion
// below still passes against a graph nobody can select.
describe('minimax music workflow reachability', () => {
  it('is offered on txt2music', () => {
    expect(workflowConfigs.txt2music.ecosystemIds).toContain(ECO.MiniMaxMusic3);
  });

  // The second half of canGenerate — resolveCanGenerateForVersions ANDs the
  // coverage gate with this. Coverage is DB state we seed by hand; this half is
  // the constants, and without an ecosystemSupport row it is false however the
  // rows are seeded, with the Create button simply absent.
  it('supports Checkpoint generation under its base model name', () => {
    expect(isBaseModelGenerationSupported('MiniMax Music 3', 'Checkpoint')).toBe(true);
  });
});

describe('minimax music mode', () => {
  it('defaults to simple, where the prompt is the only text input', () => {
    const snapshot = init().getSnapshot();
    expect(snapshot.minimaxMusicMode).toBe('simple');
    expect(snapshot.prompt).toBeDefined();
    // Naming both keys matters: the discriminator swapping to the wrong subgraph
    // would leave `prompt` defined and go unnoticed if only that were checked.
    expect(snapshot.musicDescription).toBeUndefined();
    expect(snapshot.lyrics).toBeUndefined();
  });

  it('swaps to the caption + lyrics pair in custom mode', () => {
    const graph = init();
    graph.set({ minimaxMusicMode: 'custom' });
    const snapshot = graph.getSnapshot();
    expect(snapshot.prompt).toBeUndefined();
    expect(snapshot.musicDescription).toBeDefined();
    expect(snapshot.lyrics).toBeDefined();
  });
});

// MiniMaxMusic3Input marks BOTH caption and lyrics non-optional, so a custom-mode
// submission missing either is rejected by the orchestrator rather than degraded.
// Dropping `required` from either editor reads here as `expected true to be false`.
describe('minimax music custom mode requirements', () => {
  it.each(['musicDescription', 'lyrics'])('requires %s', (name) => {
    const graph = init();
    graph.set({ minimaxMusicMode: 'custom' });
    expect(graph.getSnapshot(name).meta.required).toBe(true);
  });

  it('fails validation naming only the empty field', () => {
    const graph = init();
    graph.set({
      minimaxMusicMode: 'custom',
      musicDescription: 'Global Metadata: dream pop, 96 BPM, A minor.',
      lyrics: '',
    });
    const result = graph.validate();
    expect(result.success).toBe(false);
    expect(Object.keys(result.errors)).toEqual(['lyrics']);
  });

  it('passes once both are present', () => {
    const graph = init();
    graph.set({
      minimaxMusicMode: 'custom',
      musicDescription: 'Global Metadata: dream pop, 96 BPM, A minor.',
      lyrics: '[Verse]\nsomething about the rain\n\n[Chorus]\nand more of it',
    });
    expect(graph.validate().success).toBe(true);
  });
});

describe('minimax music duration', () => {
  it('defaults to the reference workflow default', () => {
    expect(init().getSnapshot().duration).toBe(MINIMAX_MUSIC_DEFAULT_DURATION);
  });

  // The model caps at five minutes; a value past that is clamped rather than
  // sent, so the slider and the request cannot disagree.
  it('clamps past the five-minute ceiling', () => {
    const graph = init();
    graph.set({ minimaxMusicMode: 'simple', prompt: 'a lullaby', duration: 900 });
    const result = graph.validate();
    expect(result.success).toBe(true);
    expect(result.data.duration).toBe(MINIMAX_MUSIC_MAX_DURATION);
  });
});
