import { describe, expect, it } from 'vitest';
import { aspectRatioDimensions } from '~/shared/constants/generation.constants';
import { qwenAspectRatios } from '~/shared/form-graph/generation/image/qwen.graph';
import {
  defaultPresetRatio,
  PRESET_MODEL_GRAPH_SIZES,
  PRESET_MODEL_SIZES,
} from '~/shared/generation/preset-sizes';

describe('PRESET_MODEL_SIZES', () => {
  it('offers the five preset ratios where a graph has them', () => {
    expect(PRESET_MODEL_SIZES.Flux2.map((s) => s.value)).toEqual([
      '16:9',
      '4:3',
      '1:1',
      '3:4',
      '9:16',
    ]);
  });

  // Qwen's graph has only one of the five; narrowing it to that one would be worse than its own three.
  it('offers a graph its whole list when it has fewer than three of them', () => {
    expect(PRESET_MODEL_SIZES.Qwen).toEqual(qwenAspectRatios);
  });

  // The comics picker sends the label as the aspect ratio, and the graph matches on the value.
  it.each(Object.entries(PRESET_MODEL_SIZES))(
    '%s: every label is its value, and 1:1 is offered',
    (_, sizes) => {
      expect(sizes.length).toBeGreaterThan(0);
      for (const size of sizes) expect(size.label).toBe(size.value);
      expect(sizes.some((s) => s.value === '1:1')).toBe(true);
    }
  );

  // The record resolves against the graph list, so what the picker offers must be part of it.
  it.each(Object.entries(PRESET_MODEL_SIZES))(
    '%s: offers a subset of its graph list',
    (key, sizes) => {
      for (const size of sizes) expect(PRESET_MODEL_GRAPH_SIZES[key]).toContain(size);
    }
  );

  // Seedream's resolution toggle defaults to 4K but the presets send 2K; the 4K list would record
  // 4096px sizes for 2048px images.
  it('records Seedream at the 2K the preset asks for', () => {
    const square = PRESET_MODEL_GRAPH_SIZES.Seedream.find((s) => s.value === '1:1');
    expect(square).toMatchObject(aspectRatioDimensions['2K']['1:1']);
  });

  it('starts a preset on a portrait ratio where it has one', () => {
    expect(defaultPresetRatio(PRESET_MODEL_SIZES.NanoBanana2)).toBe('3:4');
    expect(defaultPresetRatio(PRESET_MODEL_SIZES.Qwen)).toBe('2:3');
  });
});
