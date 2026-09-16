import { describe, expect, it } from 'vitest';
import {
  getEcosystemDisplayItems,
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

const ext: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  flags: { yue2Generator: true },
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
  async function submit(overrides: Record<string, unknown> = {}) {
    const parsed = parse({ ...base, ...overrides });
    if (!parsed.success) throw new Error(JSON.stringify(parsed.errors));
    if (!('ecosystem' in parsed.data)) throw new Error('Missing ecosystem');
    expect(parsed.data.ecosystem).toBe('YuE2');
    return dispatch(parsed.data, ctx);
  }

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
  it('requires its feature flag and preserves the other music generators', () => {
    const hidden = getStates('txt2music', { ...ext, flags: {} });
    expect(hidden.hiddenEcosystems).toContain('YuE2');
    expect(hidden.compatibleEcosystems).toEqual(expect.arrayContaining(['Ace', 'MiniMaxMusic3']));
    expect(getStates('txt2music', ext).compatibleEcosystems).toContain('YuE2');
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
});
