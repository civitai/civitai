import { describe, expect, it } from 'vitest';
import {
  getEcosystemDisplayItems,
  isBaseModelGenerationSupported,
  isSelfHostedEcosystem,
} from '@civitai/shared/basemodel.constants';
import { generationGraph } from '~/shared/data-graph/generation/generation-graph';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { getEcosystemStates } from '~/shared/data-graph/generation/ecosystem-graph';
import { getEcosystemStates as getFormEcosystemStates } from '~/shared/form-graph/generation/ecosystem-gates';
import { createEcosystemStepInput } from '../ecosystems';
import { createFormGraphStepInput } from '../form-graph';
import { formatStepOutputs, type GenerationHandlerCtx } from '../orchestration-new.service';
import { mapDataToGraphInput } from '../legacy-metadata-mapper';
import type { GenerationResource } from '~/shared/types/generation.types';

const ext: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};
const ctx = {
  airs: {
    getOrThrow: () => {
      throw new Error('YuE2 uses the recipe checkpoint');
    },
  },
  user: { id: 1, isModerator: true },
  baseStepIndex: 0,
} as unknown as GenerationHandlerCtx;
const base = {
  workflow: 'txt2music',
  ecosystem: 'YuE2',
  yue2MusicMode: 'custom',
  musicDescription: 'Warm synth-pop, female vocals, 105 BPM',
  lyrics: '[verse]\nMorning light is on the water',
  seed: 42,
};

describe.each([
  {
    name: 'data-graph',
    parse: (input: Record<string, unknown>) => generationGraph.safeParse(input, ext),
    dispatch: createEcosystemStepInput,
  },
  {
    name: 'form-graph',
    parse: (input: Record<string, unknown>) => generationHub.parse(input, ext),
    dispatch: createFormGraphStepInput,
  },
])('YuE2 $name', ({ parse, dispatch }) => {
  it('opens the official model card in the music generator with v2 selected', () => {
    const model = {
      id: 3337846,
      baseModel: 'YuE2',
      model: { id: 2944296, type: 'Checkpoint' },
    };
    const params = mapDataToGraphInput({}, [model as GenerationResource]);
    expect(params).toMatchObject({ ecosystem: 'YuE2', workflow: 'txt2music' });
    const parsed = parse({ ...params, model, prompt: 'A hopeful synth-pop song' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      ecosystem: 'YuE2',
      workflow: 'txt2music',
      model: { id: 3337846 },
      yue2MusicMode: 'simple',
    });
  });

  it('selects the official v2 checkpoint when starting from the ecosystem picker', () => {
    const parsed = parse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ model: { id: 3337846 } });
  });

  async function submit(overrides: Record<string, unknown> = {}) {
    const parsed = parse({ ...base, ...overrides });
    if (!parsed.success) throw new Error(JSON.stringify(parsed.errors));
    if (!('ecosystem' in parsed.data)) throw new Error('Missing ecosystem');
    expect(parsed.data.ecosystem).toBe('YuE2');
    return dispatch(parsed.data, ctx);
  }

  it('defaults to a single prompt and drops inactive Custom controls', () => {
    const parsed = parse({
      ...base,
      yue2MusicMode: undefined,
      prompt: 'A hopeful synth-pop song about sunrise',
      steps: 80,
      yue2Mode: 'off',
      yue2Abc: 'X:1\nK:C\nC D E G |',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({ yue2MusicMode: 'simple', duration: 120 });
    for (const key of ['musicDescription', 'lyrics', 'steps', 'yue2Mode', 'yue2Abc']) {
      expect(parsed.data).not.toHaveProperty(key);
    }
  });

  it('requires only the prompt in Simple mode', () => {
    const parsed = parse({ workflow: 'txt2music', ecosystem: 'YuE2', prompt: '   ' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(Object.keys(parsed.errors)).toEqual(['prompt']);
  });

  it('drafts lyrics with the same hidden chat step and schema as MiniMax', async () => {
    const prompt = 'A hopeful synth-pop song about sunrise';
    const result = await submit({ yue2MusicMode: 'simple', prompt, duration: 60 });
    expect(result.map((step) => step.$type)).toEqual(['chatCompletion', 'yuE2']);
    const [chat, music] = result;
    expect(chat).toMatchObject({
      metadata: { suppressOutput: true },
      input: {
        model: 'gpt-4o-mini',
        temperature: 0.9,
        responseFormat: {
          type: 'json_schema',
          jsonSchema: {
            name: 'song_concept',
            strict: true,
            schema: {
              type: 'object',
              properties: { caption: { type: 'string' }, lyrics: { type: 'string' } },
              required: ['caption', 'lyrics'],
              additionalProperties: false,
            },
          },
        },
      },
    });
    expect(music.input).toEqual({
      style: { $ref: '$0', path: 'output.parsed.caption' },
      lyrics: { $ref: '$0', path: 'output.parsed.lyrics' },
      seed: 42,
      maxDuration: 60,
      steps: 32,
      mode: 'full',
    });

    const minimax = parse({
      workflow: 'txt2music',
      ecosystem: 'MiniMaxMusic3',
      prompt,
      duration: 60,
    });
    if (!minimax.success) throw new Error(JSON.stringify(minimax.errors));
    if (!('ecosystem' in minimax.data)) throw new Error('Missing ecosystem');
    expect((await dispatch(minimax.data, ctx))[0]).toEqual(chat);
  });

  it('uses automatic score planning and default steps despite stale Custom values', async () => {
    const [, music] = await submit({
      yue2MusicMode: 'simple',
      prompt: 'A hopeful synth-pop song',
      yue2Mode: 'off',
      yue2Abc: 'X:1\nK:C\nC D E G |',
      steps: 80,
    });
    expect(music.input).toMatchObject({ mode: 'full', steps: 32 });
    expect(music.input).not.toHaveProperty('abc');
  });

  it('sends required text and the live contract defaults without a resource override', async () => {
    const steps = await submit();
    expect(steps).toEqual([
      {
        $type: 'yuE2',
        input: {
          style: base.musicDescription,
          lyrics: base.lyrics,
          seed: 42,
          maxDuration: 120,
          steps: 32,
          mode: 'full',
          abc: undefined,
        },
      },
    ]);
  });

  it.each(['musicDescription', 'lyrics'])('rejects blank %s', (key) => {
    const parsed = parse({ ...base, [key]: '   ' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(Object.keys(parsed.errors)).toContain(key);
  });

  it('clamps stored duration and steps to the API limits', async () => {
    const [step] = await submit({ duration: 900, steps: 120 });
    expect(step.input).toMatchObject({ maxDuration: 360, steps: 100 });
  });

  it('preserves a supplied ABC melody', async () => {
    const abc = 'X:1\nM:4/4\nL:1/4\nK:C\nC D E G |';
    const [step] = await submit({ yue2Mode: 'melody', yue2Abc: abc });
    expect(step.input).toMatchObject({ mode: 'melody', abc });
  });

  it('omits a stale score when planning is off', async () => {
    const [step] = await submit({ yue2Mode: 'off', yue2Abc: 'X:1\nK:C\nC D E G |' });
    expect(step.input).toMatchObject({ mode: 'off' });
    expect(step.input).not.toHaveProperty('abc', expect.any(String));
  });

  it('generates an int32 seed when none was selected', async () => {
    const [step] = await submit({ seed: undefined });
    if (step.$type !== 'yuE2') throw new Error('Expected YuE2');
    expect(step.input.seed).toBeGreaterThanOrEqual(0);
    expect(step.input.seed).toBeLessThanOrEqual(2147483647);
  });
});

describe.each([getEcosystemStates, getFormEcosystemStates])('YuE2 visibility', (getStates) => {
  it('is offered without a feature flag alongside the other music generators', () => {
    const states = getStates('txt2music', { ...ext, flags: {} });
    expect(states.hiddenEcosystems).not.toContain('YuE2');
    expect(states.compatibleEcosystems).toEqual(
      expect.arrayContaining(['Ace', 'MiniMaxMusic3', 'YuE2'])
    );
  });

  // Gate rules are the ONLY mechanism that hides an ecosystem now that the
  // feature-flag gate is gone, and this is the only absolute assertion that the
  // fold runs at all — deleting it from both lanes otherwise breaks no test.
  it('hides an ecosystem a gate rule targets, and leaves its siblings alone', () => {
    const gateRules = [
      {
        id: 'hide-yue2',
        name: '',
        availableTo: 'nobody' as const,
        presentation: 'hidden' as const,
        ecosystems: ['YuE2'],
        workflows: [],
        modelVersionIds: [],
      },
    ];
    const gated = getStates('txt2music', { ...ext, gateRules });
    expect(gated.hiddenEcosystems).toContain('YuE2');
    expect(gated.compatibleEcosystems).not.toContain('YuE2');
    expect(gated.compatibleEcosystems).toEqual(expect.arrayContaining(['Ace', 'MiniMaxMusic3']));
  });
});

it('formats a completed YuE2 song as playable audio', () => {
  const { output } = formatStepOutputs({
    $type: 'yuE2',
    name: '$0',
    output: {
      blob: { id: 'song.mp3', type: 'audio', url: 'https://example.com/song.mp3', available: true },
    },
  } as Parameters<typeof formatStepOutputs>[0]);
  expect(output).toHaveLength(1);
  expect(output[0]).toMatchObject({ type: 'audio', url: 'https://example.com/song.mp3' });
});

it('offers YuE2 in the audio picker and applies self-hosted availability', () => {
  expect(getEcosystemDisplayItems({ outputType: 'audio', compatibleEcosystems: ['YuE2'] })).toEqual(
    expect.arrayContaining([expect.objectContaining({ key: 'YuE2', compatible: true })])
  );
  expect(isSelfHostedEcosystem('YuE2')).toBe(true);
  expect(isBaseModelGenerationSupported('YuE2', 'Checkpoint')).toBe(true);
  expect(isBaseModelGenerationSupported('YuE2', 'LORA')).toBe(false);
});
