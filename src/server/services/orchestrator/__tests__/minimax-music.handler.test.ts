import { describe, expect, it } from 'vitest';

import { createEcosystemStepInput } from '../ecosystems';
import { minimaxMusicVersionIds } from '~/shared/data-graph/generation/minimax-music-graph';
import { formatStepOutputs, type GenerationHandlerCtx } from '../orchestration-new.service';
import { WorkflowData } from '~/shared/orchestrator/workflow-data';

const ctx = {
  airs: { getOrThrow: (id: number) => `air:${id}` },
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
} as unknown as GenerationHandlerCtx;

const base = {
  ecosystem: 'MiniMaxMusic3',
  workflow: 'txt2music',
  model: { id: minimaxMusicVersionIds['v3.0'] },
  duration: 60,
};

// Routed through the dispatcher rather than the handler directly: the switch case
// is the wiring most easily forgotten, and a missing one throws
// `Unknown ecosystem: MiniMaxMusic3` here rather than at submit time.
const steps = (data: Record<string, unknown>) =>
  createEcosystemStepInput({ ...base, ...data } as any, ctx);

const simple = { minimaxMusicMode: 'simple', prompt: 'a lullaby about the sea' };
const custom = {
  minimaxMusicMode: 'custom',
  musicDescription: 'Global Metadata: dream pop, 96 BPM, A minor.',
  lyrics: '[Verse]\nsalt on the window',
};

describe('minimax music simple mode', () => {
  it('drafts the caption and lyrics in a suppressed chat step first', async () => {
    const result = await steps(simple);
    expect(result.map((s) => s.$type)).toEqual(['chatCompletion', 'miniMaxMusic3']);
    expect((result[0] as any).metadata.suppressOutput).toBe(true);
  });

  // The two $refs are the whole mechanism: an index off by one, or a path that
  // does not match the response schema, silently submits `undefined` for a field
  // the orchestrator requires.
  it('points both required fields at that step', async () => {
    const [, music] = await steps(simple);
    const input = music.input as any;
    expect(input.caption).toEqual({ $ref: '$0', path: 'output.parsed.caption' });
    expect(input.lyrics).toEqual({ $ref: '$0', path: 'output.parsed.lyrics' });
  });

  it('asks the drafting model for exactly those two keys', async () => {
    const [chat] = await steps(simple);
    const schema = (chat.input as any).responseFormat.jsonSchema.schema;
    expect(schema.required).toEqual(['caption', 'lyrics']);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe('minimax music custom mode', () => {
  it('sends the user text straight through with no chat step', async () => {
    const result = await steps(custom);
    expect(result.map((s) => s.$type)).toEqual(['miniMaxMusic3']);
    const input = result[0].input as any;
    expect(input.caption).toBe(custom.musicDescription);
    expect(input.lyrics).toBe(custom.lyrics);
  });
});

describe('minimax music step input', () => {
  it('carries the duration as a cap', async () => {
    const [music] = await steps(custom);
    expect((music.input as any).maxDuration).toBe(60);
  });

  // `seed` is non-optional on MiniMaxMusic3Input, and `removeEmpty` would strip
  // an undefined one — so a request with no seed must still carry a number.
  it('always sends a seed, even when the form left it blank', async () => {
    const [music] = await steps(custom);
    expect(typeof (music.input as any).seed).toBe('number');
  });

  it('keeps a seed the user pinned', async () => {
    const [music] = await steps({ ...custom, seed: 4242 });
    expect((music.input as any).seed).toBe(4242);
  });

  // The recipe resolves its own diffusion model, text encoder and VAE. Sending a
  // partial override set would risk pairing our checkpoint with its defaults for
  // the other two.
  it('sends no weight overrides', async () => {
    const [music] = await steps(custom);
    const input = music.input as any;
    expect(input.diffusionModel).toBeUndefined();
    expect(input.textEncoder).toBeUndefined();
    expect(input.vae).toBeUndefined();
  });
});

// The handler emits `$type: 'miniMaxMusic3'`, but the output formatter and the
// client's `mediaType` both switch on that string with an image-shaped default —
// so an unhandled case renders an empty queue card with no error anywhere.
describe('minimax music output rendering', () => {
  const step = {
    $type: 'miniMaxMusic3',
    name: 'music',
    output: { blob: { id: 'blob-1', type: 'audio', url: 'https://x/song.mp3', available: true } },
  };

  it('formats the audio blob into a renderable output', () => {
    const { output } = formatStepOutputs(step as any);
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe('audio');
  });

  it('reports the step as audio to the client', () => {
    const workflow = new WorkflowData(
      { id: 'wf-1', status: 'succeeded', steps: [{ ...step, output: [] }] } as any,
      { domain: { green: false }, nsfwEnabled: true } as any
    );
    expect(workflow.steps[0].mediaType).toBe('audio');
  });
});
