import { describe, expect, it } from 'vitest';
import { getSimilarFiles } from '~/components/Resource/file-conflicts';

type TestFile = Parameters<typeof getSimilarFiles>[0][number];

const file = (overrides: Partial<TestFile>): TestFile => ({
  name: 'model.safetensors',
  type: 'Diffusion Model',
  fp: 'int8',
  ...overrides,
});

describe('getSimilarFiles', () => {
  it('groups files that share type, precision and format', () => {
    const fl2va = file({ name: 'minimax_h3_fl2va_bf16.safetensors', fp: 'bf16' });
    const ref2va = file({ name: 'minimax_h3_ref2va_bf16.safetensors', fp: 'bf16' });
    const int8 = file({ name: 'minimax_h3_fl2va_int8.safetensors' });

    expect(getSimilarFiles([fl2va, ref2va, int8])).toEqual([[fl2va, ref2va]]);
  });

  it('ignores files that differ in precision, type or format', () => {
    expect(
      getSimilarFiles([
        file({ name: 'a.safetensors', fp: 'int8' }),
        file({ name: 'b.safetensors', fp: 'bf16' }),
        file({ name: 'c.safetensors', type: 'VAE' }),
        file({ name: 'd.gguf', quantType: 'Q4_K_M', fp: undefined }),
      ])
    ).toEqual([]);
  });

  it('ignores components with no settings to tell them apart', () => {
    expect(
      getSimilarFiles([
        file({ name: 'a.safetensors', type: 'Text Encoder', fp: undefined }),
        file({ name: 'b.safetensors', type: 'Text Encoder', fp: undefined }),
      ])
    ).toEqual([]);
  });
});
