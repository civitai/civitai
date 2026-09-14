import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

/** A bare version id does not move the checkpoint — the field takes a resource. */
const checkpoint = (id: number) => ({
  id,
  baseModel: 'MiniMax H3',
  model: { type: 'Checkpoint' },
});

const COMFY = checkpoint(3216500);
const API = checkpoint(3183239);

function store(workflow: string, model = COMFY, extra: Record<string, unknown> = {}) {
  const s = generationHub.createStore({ ext: EXT });
  s.set({ workflow, ecosystem: 'MiniMaxH3', prompt: 'x', model, ...extra });
  return s;
}

/** A field gated off resolves to null; one the graph never declares is undefined. */
const declared = (s: ReturnType<typeof store>, key: string) => s.getField(key as never) != null;

// A field the graph doesn't declare renders nothing — the section silently
// disappears with no error.
describe('minimax controlVideo field availability', () => {
  it('is declared on the comfy build, txt2vid', () => {
    const s = store('txt2vid');
    expect(declared(s, 'controlVideo')).toBe(true);
    expect((s.getField('controlVideo')?.meta as { options?: unknown[] })?.options).toHaveLength(5);
  });

  it.each(['img2vid', 'img2vid:first-last', 'img2vid:ref2vid'])(
    'is not declared on comfy %s',
    (workflow) => {
      expect(declared(store(workflow), 'controlVideo')).toBe(false);
    }
  );

  it('is not declared on the hosted API build', () => {
    const s = store('txt2vid', API);
    // Positive control: `steps` is comfy-only, so its absence proves the branch
    // actually switched rather than the model set being a no-op.
    expect(declared(s, 'steps')).toBe(false);
    expect(declared(s, 'controlVideo')).toBe(false);
  });

  it('accepts a staged control video and validates', () => {
    const s = store('txt2vid');
    s.set({
      controlVideo: {
        preprocessor: 'canny',
        mode: 'auto',
        video: { url: 'https://example.test/control.mp4' },
        strength: 0.8,
        startPercent: 0,
        endPercent: 1,
      },
    } as never);

    const result = s.validate();
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data.controlVideo).toMatchObject({
      preprocessor: 'canny',
      mode: 'auto',
      strength: 0.8,
    });
  });
});
