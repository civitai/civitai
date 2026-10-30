import { describe, expect, it } from 'vitest';

import { toMeshyV71PolyGenInput } from '~/server/orchestrator/polygen/polygen-v71.schema';
import { toTripoH31PolyGenInput } from '~/server/orchestrator/tripo/tripo.schema';
import {
  getPolygenVersionOptions,
  isPolygenVersionRunnable,
} from '~/shared/form-graph/generation/model3d/polygen.graph';
import {
  getTripoVersionOptions,
  resolveTripoVersion,
} from '~/shared/form-graph/generation/model3d/tripo.graph';

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

describe('Tripo H3.1 input', () => {
  const base = {
    texture: 'standard' as const,
    pbr: false,
    quad: false,
    autoSize: false,
    textureAlignment: 'original_image' as const,
    orientation: 'default' as const,
  };

  it('picks imageTo3D for one image and multiviewTo3D for several', () => {
    expect(toTripoH31PolyGenInput({ ...base, sourceImages: [image(1)] })).toMatchObject({
      version: 'h3.1',
      operation: 'imageTo3D',
      imageUrl: 'https://x/1.png',
    });
    expect(toTripoH31PolyGenInput({ ...base, sourceImages: [image(1), image(2)] })).toMatchObject({
      operation: 'multiviewTo3D',
      imageUrls: ['https://x/1.png', 'https://x/2.png'],
    });
  });

  it('maps the None / Standard / HD texture control', () => {
    const make = (texture: 'no' | 'standard' | 'HD') =>
      toTripoH31PolyGenInput({ ...base, texture, sourceImages: [image(1)] });
    expect(make('no')).toMatchObject({ texture: false });
    expect(make('standard')).toMatchObject({ texture: true, textureQuality: 'standard' });
    expect(make('HD')).toMatchObject({ texture: true, textureQuality: 'detailed' });
  });

  it('drops negative seeds, which H3.1 rejects', () => {
    const input = toTripoH31PolyGenInput({
      ...base,
      sourceImages: [image(1)],
      seed: -1,
      textureSeed: 5,
    });
    expect(input).not.toHaveProperty('seed');
    expect(input).toMatchObject({ textureSeed: 5 });
  });
});

describe('version gating', () => {
  it('runs v7.1 on text-to-3D but clamps v7 off it', () => {
    expect(isPolygenVersionRunnable('v7.1', 'txt2model3d')).toBe(true);
    expect(isPolygenVersionRunnable('v7', 'txt2model3d')).toBe(false);
  });

  it('offers v7.1 and H3.1 only behind their flags', () => {
    const values = (options: readonly { value: string }[]) => options.map((o) => o.value);
    expect(values(getPolygenVersionOptions({}))).toEqual(['v6']);
    expect(values(getPolygenVersionOptions({ meshyV71Generator: true }))).toEqual(['v6', 'v7.1']);
    expect(values(getTripoVersionOptions({}))).toEqual(['v2.5']);
    expect(values(getTripoVersionOptions({ tripoH31Generator: true }))).toEqual(['v2.5', 'h3.1']);
  });

  // The clamp, not the option list, is what stops a crafted submit.
  it('runs a submitted H3.1 only when its flag is on', () => {
    expect(resolveTripoVersion('h3.1', {})).toBe('v2.5');
    expect(resolveTripoVersion('h3.1', { tripoH31Generator: true })).toBe('h3.1');
  });
});
