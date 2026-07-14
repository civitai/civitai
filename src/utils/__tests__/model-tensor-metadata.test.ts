import { describe, expect, it } from 'vitest';
import { analyzeModelTensors, getDominantWeightPrecision } from '~/utils/model-tensor-metadata';

describe('getDominantWeightPrecision', () => {
  it('combines float8 variants into FP8 before comparing their weight bytes', () => {
    expect(
      getDominantWeightPrecision([
        { dtype: 'F8_E4M3FN', count: 2, bytes: 40 },
        { dtype: 'F8_E5M2', count: 1, bytes: 30 },
        { dtype: 'BF16', count: 1, bytes: 60 },
      ])
    ).toBe('FP8');
  });

  it.each([
    ['BF16', 'BF16'],
    ['F16', 'FP16'],
    ['Q4_K', 'Q4'],
    ['Q8_0', 'Q8'],
    ['IQ4_XS', 'IQ4'],
  ])('normalizes %s as %s', (dtype, expected) => {
    expect(getDominantWeightPrecision([{ dtype, count: 1, bytes: 100 }])).toBe(expected);
  });

  it('returns null when no dtype accounts for any weight bytes', () => {
    expect(getDominantWeightPrecision([{ dtype: 'F16', count: 0, bytes: 0 }])).toBeNull();
  });
});

describe('analyzeModelTensors', () => {
  it('includes the dominant weight precision in the cached analysis', () => {
    const analysis = analyzeModelTensors(
      'GGUF',
      [
        { name: 'layer.0.weight', shape: [1], dtype: 'Q4_K', sizeBytes: 90 },
        { name: 'layer.0.scale', shape: [1], dtype: 'Q6_K', sizeBytes: 10 },
      ],
      { estimateVram: false }
    );

    expect(analysis.weightPrecision).toBe('Q4');
  });
});
