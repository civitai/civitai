import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import { createFormGraphStepInput } from '../form-graph';
import type { GenerationHandlerCtx } from '../orchestration-new.service';

const ext: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  flags: { seedAudioGenerator: true },
  gateRules: [],
};
const ctx = {
  airs: {
    getOrThrow: () => {
      throw new Error('Seed Audio takes no resources');
    },
  },
  user: { id: 1, isModerator: true },
  baseStepIndex: 0,
} as unknown as GenerationHandlerCtx;
const prompt = 'A calm narrator says "Welcome back to the show." Soft piano underneath.';
const base = { workflow: 'txt2music', ecosystem: 'SeedAudio', prompt };

const parse = (input: Record<string, unknown>) => generationHub.parse(input, ext);

describe('Seed Audio', () => {
  async function submit(overrides: Record<string, unknown> = {}) {
    const parsed = parse({ ...base, ...overrides });
    if (!parsed.success) throw new Error(JSON.stringify(parsed.errors));
    if (!('ecosystem' in parsed.data)) throw new Error('Missing ecosystem');
    expect(parsed.data.ecosystem).toBe('SeedAudio');
    return createFormGraphStepInput(parsed.data, ctx);
  }

  it('sends a generate step with no model', async () => {
    expect(await submit()).toEqual([
      { $type: 'seedAudioGen', input: { operation: 'generate', prompt, referenceImage: null } },
    ]);
  });

  it('sends the reference image', async () => {
    const [step] = await submit({
      images: [{ url: 'https://x/scene.jpg', width: 512, height: 512 }],
    });
    expect(step.input).toMatchObject({ referenceImage: 'https://x/scene.jpg' });
  });

  it('refuses Seed Audio when its flag is off', () => {
    const parsed = generationHub.parse(base, { ...ext, flags: {} });
    expect(parsed.success && 'ecosystem' in parsed.data && parsed.data.ecosystem).not.toBe(
      'SeedAudio'
    );
  });

  it('sends the prompt as typed, quotes included', async () => {
    const typed = `A deep voice says '"And so, it begins'" and a band starts jazzing`;
    const [step] = await submit({ prompt: typed });
    expect(step.input).toMatchObject({ prompt: typed });
  });
});
