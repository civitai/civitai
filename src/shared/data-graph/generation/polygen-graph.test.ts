import { describe, expect, it } from 'vitest';
import { generationGraph } from './generation-graph';
import type { GenerationCtx } from './context';
import { toMeshyV7PolyGenInput } from '~/server/orchestrator/polygen/polygen-v7.schema';
import { getPolygenVersionOptions, isPolygenVersionRunnable } from './polygen-graph';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createPolyGenInput } from '~/server/services/orchestrator/ecosystems/polygen-graph.handler';

const baseExt: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  gateRules: [],
  flags: { model3dGenerator: true, meshyV7Generator: true },
};

function init(workflow = 'img2model3d', ext: GenerationCtx = baseExt) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graph = generationGraph as any;
  graph.init({ workflow, ecosystem: 'PolyGen' }, ext);
  return graph;
}

const image = (url: string) => ({ url, width: 512, height: 512 });

// Meshy v7 is a VERSION inside the PolyGen ecosystem, not a second row in the
// "Eco" picker — so these drive `ecosystem: 'PolyGen'` throughout and switch
// `polygenVersion` instead.
describe('polygen version selector', () => {
  const versionValues = (g: ReturnType<typeof init>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    g.getSnapshot('polygenVersion').meta.options.map((o: any) => o.value);

  it('offers v7 on the image workflow when the flag is on', () => {
    expect(versionValues(init())).toEqual(['v6', 'v7']);
  });

  // The whole point of the control is that the user can SEE both and choose.
  // Restricting the rendered options by workflow hid it entirely on
  // txt2model3d — the 3D category's default workflow — so both render there.
  it('still offers both on the text workflow so the choice is visible', () => {
    expect(versionValues(init('txt2model3d'))).toEqual(['v6', 'v7']);
  });

  // Fail-closed: the option list IS the flag gate.
  it('drops v7 when meshyV7Generator is off', () => {
    const off = init('img2model3d', { ...baseExt, flags: { model3dGenerator: true } });
    expect(versionValues(off)).toEqual(['v6']);
    expect(getPolygenVersionOptions(undefined).map((o) => o.value)).toEqual(['v6']);
    expect(getPolygenVersionOptions({ model3dGenerator: true }).map((o) => o.value)).toEqual([
      'v6',
    ]);
  });

  // Rendering v7 on the text workflow must not make it SUBMITTABLE there —
  // Meshy v7 has no text-to-3D operation.
  it('knows v7 is not runnable on the text workflow', () => {
    expect(isPolygenVersionRunnable('v7', 'txt2model3d')).toBe(false);
    expect(isPolygenVersionRunnable('v7', 'img2model3d')).toBe(true);
    expect(isPolygenVersionRunnable('v6', 'txt2model3d')).toBe(true);
  });

  it('clamps a v7 value back to v6 on the text workflow', () => {
    const g = init('txt2model3d');
    g.set({ polygenVersion: 'v7' });
    expect(g.getSnapshot().polygenVersion).toBe('v6');
  });

  it('clamps a v7 value back to v6 when the flag is off', () => {
    const g = init('img2model3d', { ...baseExt, flags: { model3dGenerator: true } });
    g.set({ polygenVersion: 'v7' });
    expect(g.getSnapshot().polygenVersion).toBe('v6');
  });

  // What the form's version button does when you pick v7 while on Text to 3D:
  // one `graph.set` carrying BOTH, so the clamp evaluates against the new
  // workflow and v7 sticks.
  it('keeps v7 when the workflow moves to img2model3d in the same set', () => {
    const g = init('txt2model3d');
    g.set({ workflow: 'img2model3d', polygenVersion: 'v7' });
    expect(g.getSnapshot().workflow).toBe('img2model3d');
    expect(g.getSnapshot().polygenVersion).toBe('v7');
  });

  // A moderator with no `meshy-v7-generator` flag in Flipt must still get v7 —
  // `availability: ['mod']` is the static fallback until the flag exists.
  it('offers v7 to a moderator with no Flipt flag', () => {
    const features = getFeatureFlags({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: { id: 1, isModerator: true, tier: 'gold' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      req: { headers: {} } as any,
    });
    expect(features.meshyV7Generator).toBe(true);
    expect(versionValues(init('img2model3d', { ...baseExt, flags: features }))).toContain('v7');
  });
});

describe('polygen version-gated controls', () => {
  // `hasNode` is what `useGraphSubscription` checks; a missing node makes
  // `Controller` render null, which is how a control disappears from the form.
  it('shows the v7 controls only on v7', () => {
    const g = init();
    expect(g.hasNode('poseMode')).toBe(false);
    expect(g.hasNode('ultraMode')).toBe(false);
    expect(g.hasNode('modelType')).toBe(false);
    expect(g.hasNode('seed')).toBe(true);

    g.set({ polygenVersion: 'v7' });
    expect(g.hasNode('poseMode')).toBe(true);
    expect(g.hasNode('ultraMode')).toBe(true);
    expect(g.hasNode('modelType')).toBe(true);
    // v7 has no seed — the orchestrator type only carries one on the v6 branch.
    expect(g.hasNode('seed')).toBe(false);
  });

  it('keeps the text-to-3D controls on v6 only', () => {
    const txt = init('txt2model3d');
    expect(txt.hasNode('prompt')).toBe(true);
    expect(txt.hasNode('polygenMode')).toBe(true);
    // v7 clamps to v6 on the text workflow, so the prompt can never be orphaned.
    expect(txt.getSnapshot().polygenVersion).toBe('v6');
  });

  it('hides ultraMode / modelType once a second view is added', () => {
    const g = init();
    g.set({ polygenVersion: 'v7', images: [image('https://image.civitai.com/a')] });
    expect(g.hasNode('ultraMode')).toBe(true);
    expect(g.hasNode('modelType')).toBe(true);

    g.set({ images: [image('https://image.civitai.com/a'), image('https://image.civitai.com/b')] });
    expect(g.hasNode('ultraMode')).toBe(false);
    expect(g.hasNode('modelType')).toBe(false);
  });

  it('exposes the rigging controls only while Animate is on', () => {
    const g = init();
    g.set({ polygenVersion: 'v7' });
    expect(g.hasNode('riggingHeightMeters')).toBe(false);
    expect(g.hasNode('animationActionId')).toBe(false);

    g.set({ enableAnimation: true });
    expect(g.hasNode('riggingHeightMeters')).toBe(true);
    expect(g.hasNode('animationActionId')).toBe(true);
  });
});

// End-to-end: real graph → real handler. The `toMeshyV7PolyGenInput` tests at
// the bottom feed the converter hand-built data, so they cannot catch the graph
// handing the handler a shape it doesn't expect — e.g. the `images` cap being
// wrong per version, or the handler branching on the wrong field.
describe('polygen graph → handler, by version', () => {
  async function stepFor(patch: Record<string, unknown>, workflow = 'img2model3d') {
    const g = init(workflow);
    g.set(patch);
    return (await createPolyGenInput(
      g.getSnapshot(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { baseStepIndex: 0 } as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any[];
  }

  it('caps images at 1 on v6 and 4 on v7', () => {
    const g = init();
    expect(g.getSnapshot('images').meta.max).toBe(1);
    g.set({ polygenVersion: 'v7' });
    expect(g.getSnapshot('images').meta.max).toBe(4);
  });

  it('routes v6 image-to-3D', async () => {
    const [step] = await stepFor({ polygenVersion: 'v6', images: [image('https://a')] });
    expect(step.input).toMatchObject({
      version: 'v6',
      operation: 'imageTo3D',
      imageUrl: 'https://a',
    });
  });

  it('routes v7 single image to imageTo3D', async () => {
    const [step] = await stepFor({ polygenVersion: 'v7', images: [image('https://a')] });
    expect(step.input).toMatchObject({
      version: 'v7',
      operation: 'imageTo3D',
      imageUrl: 'https://a',
    });
  });

  it('routes v7 multiple views to multiImageTo3D with every url', async () => {
    const [step] = await stepFor({
      polygenVersion: 'v7',
      images: [image('https://a'), image('https://b'), image('https://c'), image('https://d')],
    });
    expect(step.$type).toBe('polyGen');
    expect(step.input).toMatchObject({
      version: 'v7',
      operation: 'multiImageTo3D',
      imageUrls: ['https://a', 'https://b', 'https://c', 'https://d'],
    });
  });

  it('routes v6 text-to-3D', async () => {
    const [step] = await stepFor({ prompt: 'a treasure chest' }, 'txt2model3d');
    expect(step.input).toMatchObject({
      version: 'v6',
      operation: 'textTo3D',
      prompt: 'a treasure chest',
    });
  });

  // `imagesNode`'s input transform slices to max, so a 5th image is dropped
  // silently rather than rejected. Pinned so a cap change is visible here.
  it('caps v7 at four views', () => {
    const g = init();
    g.set({
      polygenVersion: 'v7',
      images: [
        image('https://a'),
        image('https://b'),
        image('https://c'),
        image('https://d'),
        image('https://e'),
      ],
    });
    expect(g.getSnapshot().images).toHaveLength(4);
  });
});

describe('toMeshyV7PolyGenInput', () => {
  const base = {
    shouldTexture: true,
    poseMode: 'a-pose' as const,
    ultraMode: true,
    modelType: 'standard' as const,
    targetPolycount: 30_000,
    topology: 'triangle' as const,
    symmetryMode: 'auto' as const,
    shouldRemesh: true,
    enablePbr: false,
    enableRigging: false,
    enableAnimation: false,
  };

  it('routes a single image to imageTo3D', () => {
    const input = toMeshyV7PolyGenInput({ ...base, sourceImages: [image('https://a')] });
    expect(input).toMatchObject({
      engine: 'fal',
      model: 'meshy',
      version: 'v7',
      operation: 'imageTo3D',
      imageUrl: 'https://a',
      ultraMode: true,
      modelType: 'standard',
    });
  });

  it('routes multiple views to multiImageTo3D and drops the single-image-only fields', () => {
    const input = toMeshyV7PolyGenInput({
      ...base,
      sourceImages: [image('https://a'), image('https://b')],
    });
    expect(input).toMatchObject({
      operation: 'multiImageTo3D',
      imageUrls: ['https://a', 'https://b'],
    });
    expect(input).not.toHaveProperty('ultraMode');
    expect(input).not.toHaveProperty('modelType');
    expect(input).not.toHaveProperty('imageUrl');
  });

  it('pins rigging on when animation is requested, and omits the rigging extras otherwise', () => {
    const animated = toMeshyV7PolyGenInput({
      ...base,
      sourceImages: [image('https://a')],
      enableAnimation: true,
      riggingHeightMeters: 1.7,
      animationActionId: 3,
    });
    expect(animated).toMatchObject({
      enableRigging: true,
      enableAnimation: true,
      riggingHeightMeters: 1.7,
      animationActionId: 3,
    });

    const still = toMeshyV7PolyGenInput({
      ...base,
      sourceImages: [image('https://a')],
      riggingHeightMeters: 1.7,
      animationActionId: 3,
    });
    expect(still).not.toHaveProperty('riggingHeightMeters');
    expect(still).not.toHaveProperty('animationActionId');
  });
});
