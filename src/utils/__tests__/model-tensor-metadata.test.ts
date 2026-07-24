import { describe, expect, it } from 'vitest';
import { classifyModelWeightPrecision } from '../model-tensor-metadata';

describe('classifyModelWeightPrecision', () => {
  it('aggregates all float8 variants by tensor bytes', () => {
    expect(
      classifyModelWeightPrecision([
        { dtype: 'F8_E4M3FN', count: 10, bytes: 40 },
        { dtype: 'F8_E5M2', count: 10, bytes: 35 },
        { dtype: 'BF16', count: 100, bytes: 70 },
      ])
    ).toBe('fp8');
  });

  it('groups BF16 and FP16 into the same pricing class', () => {
    expect(
      classifyModelWeightPrecision([
        { dtype: 'BF16', count: 10, bytes: 40 },
        { dtype: 'F16', count: 10, bytes: 35 },
        { dtype: 'F8_E4M3FN', count: 100, bytes: 70 },
      ])
    ).toBe('bf16-fp16');
  });

  it('uses bytes rather than tensor count', () => {
    expect(
      classifyModelWeightPrecision([
        { dtype: 'F8_E4M3FNUZ', count: 1, bytes: 100 },
        { dtype: 'BF16', count: 1_000, bytes: 50 },
      ])
    ).toBe('fp8');
  });

  it.each([
    {
      name: 'another dtype dominates',
      values: [
        { dtype: 'F32', count: 1, bytes: 200 },
        { dtype: 'BF16', count: 1, bytes: 100 },
      ],
    },
    {
      name: 'quantized bytes dominate',
      values: [
        { dtype: 'Q8_0', count: 1, bytes: 200 },
        { dtype: 'F16', count: 1, bytes: 100 },
      ],
    },
    {
      name: 'the leading classes tie',
      values: [
        { dtype: 'F8_E4M3FN', count: 1, bytes: 100 },
        { dtype: 'BF16', count: 1, bytes: 100 },
      ],
    },
    { name: 'there are no usable bytes', values: [] },
    {
      name: 'byte values are invalid',
      values: [
        { dtype: 'F8_E4M3FN', count: 1, bytes: Number.NaN },
        { dtype: 'BF16', count: 1, bytes: -1 },
      ],
    },
  ])('returns null when $name', ({ values }) => {
    expect(classifyModelWeightPrecision(values)).toBeNull();
  });
});
