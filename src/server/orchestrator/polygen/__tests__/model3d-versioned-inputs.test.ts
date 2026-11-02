import { describe, expect, it } from 'vitest';

import { toMeshyV71PolyGenInput } from '~/server/orchestrator/polygen/polygen-v71.schema';
import {
  getPolygenVersionOptions,
  isPolygenVersionRunnable,
} from '~/shared/form-graph/generation/model3d/polygen.graph';

const image = (n: number) => ({ url: `https://x/${n}.png`, width: 1024, height: 1024 });

describe('Meshy v7.1 input', () => {
  it('builds text-to-3D with its seed', () => {
    const input = toMeshyV71PolyGenInput({ process: 'textTo3D', prompt: 'a chest', seed: 7 });
    expect(input).toMatchObject({
      version: 'v7.1',
      operation: 'textTo3D',
      prompt: 'a chest',
      seed: 7,
    });
  });

  it('picks imageTo3D for one image and multiImageTo3D for several', () => {
    expect(
      toMeshyV71PolyGenInput({ process: 'imageTo3D', sourceImages: [image(1)] })
    ).toMatchObject({
      operation: 'imageTo3D',
      imageUrl: 'https://x/1.png',
    });
    expect(
      toMeshyV71PolyGenInput({ process: 'imageTo3D', sourceImages: [image(1), image(2)] })
    ).toMatchObject({
      operation: 'multiImageTo3D',
      imageUrls: ['https://x/1.png', 'https://x/2.png'],
    });
  });

  // The orchestrator rejects 4K on multi-image and any 2K/4K with smart topology.
  it('caps multi-image geometry at 2K', () => {
    const input = toMeshyV71PolyGenInput({
      process: 'imageTo3D',
      sourceImages: [image(1), image(2)],
      geometryResolution: '4k',
    });
    expect(input).toMatchObject({ geometryResolution: '2k' });
  });

  it('drops geometry resolution under smart topology', () => {
    const input = toMeshyV71PolyGenInput({
      process: 'imageTo3D',
      sourceImages: [image(1)],
      modelType: 'smart-topology',
      geometryResolution: '4k',
    });
    expect(input).not.toHaveProperty('geometryResolution');
  });

  it('turns rigging on whenever animation is on', () => {
    const input = toMeshyV71PolyGenInput({
      process: 'imageTo3D',
      sourceImages: [image(1)],
      enableAnimation: true,
      enableRigging: false,
    });
    expect(input).toMatchObject({ enableAnimation: true, enableRigging: true });
  });
});

describe('version gating', () => {
  it('runs v7.1 on text-to-3D but clamps v7 off it', () => {
    expect(isPolygenVersionRunnable('v7.1', 'txt2model3d')).toBe(true);
    expect(isPolygenVersionRunnable('v7', 'txt2model3d')).toBe(false);
  });

  it('offers v7.1 only behind its flag', () => {
    const values = (options: readonly { value: string }[]) => options.map((o) => o.value);
    expect(values(getPolygenVersionOptions({}))).toEqual(['v6']);
    expect(values(getPolygenVersionOptions({ meshyV71Generator: true }))).toEqual(['v6', 'v7.1']);
  });
});
