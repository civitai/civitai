import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import { createFormGraphStepInput } from '../form-graph';
import type { GenerationHandlerCtx } from '../orchestration-new.service';

const ext: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};
const ctx = {
  airs: {
    getOrThrow: () => {
      throw new Error('Sonilo takes no resources');
    },
  },
  user: { id: 1, isModerator: true },
  baseStepIndex: 0,
} as unknown as GenerationHandlerCtx;
const base = { workflow: 'txt2music', ecosystem: 'Sonilo', prompt: 'warm lo-fi hip hop' };

const parse = (input: Record<string, unknown>) => generationHub.parse(input, ext);
const dispatch = createFormGraphStepInput;

describe('Sonilo', () => {
  async function submit(overrides: Record<string, unknown> = {}) {
    const parsed = parse({ ...base, ...overrides });
    if (!parsed.success) throw new Error(JSON.stringify(parsed.errors));
    if (!('ecosystem' in parsed.data)) throw new Error('Missing ecosystem');
    expect(parsed.data.ecosystem).toBe('Sonilo');
    return dispatch(parsed.data, ctx);
  }

  it('selects the official version when starting from the ecosystem picker', () => {
    const parsed = parse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ model: { id: 3370181 } });
  });

  it('defaults to a 60s music track', async () => {
    expect(await submit()).toEqual([
      {
        $type: 'soniloAudioGen',
        input: { operation: 'music', prompt: 'warm lo-fi hip hop', duration: 60 },
      },
    ]);
  });

  it('sends a sound effect with its own duration', async () => {
    const result = await submit({ soniloOperation: 'soundEffect', duration: 2.5 });
    expect(result).toEqual([
      {
        $type: 'soniloAudioGen',
        input: { operation: 'soundEffect', prompt: 'warm lo-fi hip hop', duration: 2.5 },
      },
    ]);
  });

  it('defaults a sound effect to 8s', async () => {
    const [step] = await submit({ soniloOperation: 'soundEffect' });
    expect(step.input).toMatchObject({ operation: 'soundEffect', duration: 8 });
  });

  // Literals, not soniloDuration: they pin Sonilo's API limits, so widening the constant fails here.
  it.each([
    ['music', 2.5, 5],
    ['music', 9999, 360],
    ['soundEffect', 300, 180],
  ])('clamps %s duration %s to %s', async (soniloOperation, duration, expected) => {
    const [step] = await submit({ soniloOperation, duration });
    expect(step.input).toMatchObject({ operation: soniloOperation, duration: expected });
  });

  it('requires a prompt', () => {
    const parsed = parse({ ...base, prompt: '   ' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(Object.keys(parsed.errors)).toContain('prompt');
  });

  it('falls back to music for an unknown operation', async () => {
    const [step] = await submit({ soniloOperation: 'speech' });
    expect(step.input).toMatchObject({ operation: 'music', duration: 60 });
  });
});
