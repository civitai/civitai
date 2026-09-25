import { describe, expect, it } from 'vitest';
import { getFileConflicts } from '~/components/Resource/file-conflicts';

type TestFile = Parameters<typeof getFileConflicts>[0][number];

const file = (overrides: Partial<TestFile>): TestFile => ({
  name: 'model.safetensors',
  type: 'Diffusion Model',
  fp: 'int8',
  ...overrides,
});

describe('getFileConflicts', () => {
  it('only warns for distinct variants that share type, precision and format', () => {
    const fl2va = file({ name: 'minimax_h3_fl2va_int8.safetensors', sizeKB: 33241106 });
    const ref2va = file({ name: 'minimax_h3_ref2va_pruned_int8.safetensors', sizeKB: 20478886 });

    const { duplicates, similar } = getFileConflicts([fl2va, ref2va]);

    expect(duplicates).toEqual([]);
    expect(similar).toEqual([[fl2va, ref2va]]);
  });

  it('blocks the same file uploaded twice', () => {
    const a = file({ name: 'lora.safetensors', type: 'Model', fp: 'bf16', sizeKB: 307498 });
    const b = file({ name: 'lora-copy.safetensors', type: 'Model', fp: 'bf16', sizeKB: 307498 });

    const { duplicates, similar } = getFileConflicts([a, b]);

    expect(duplicates).toEqual([[a, b]]);
    expect(similar).toEqual([]);
  });

  it('warns rather than blocks while a size is still unknown', () => {
    const uploaded = file({ name: 'a.safetensors', sizeKB: 100 });
    const pending = file({ name: 'b.safetensors', sizeKB: undefined });

    const { duplicates, similar } = getFileConflicts([uploaded, pending]);

    expect(duplicates).toEqual([]);
    expect(similar).toEqual([[uploaded, pending]]);
  });

  it('reports a same-size pair as a duplicate even inside a larger similar group', () => {
    const a = file({ name: 'a.safetensors', sizeKB: 100 });
    const b = file({ name: 'b.safetensors', sizeKB: 100 });
    const c = file({ name: 'c.safetensors', sizeKB: 200 });

    const { duplicates, similar } = getFileConflicts([a, b, c]);

    expect(duplicates).toEqual([[a, b]]);
    expect(similar).toEqual([]);
  });

  it('ignores files that differ in precision, type or format', () => {
    const { duplicates, similar } = getFileConflicts([
      file({ name: 'a.safetensors', fp: 'int8', sizeKB: 100 }),
      file({ name: 'b.safetensors', fp: 'bf16', sizeKB: 100 }),
      file({ name: 'c.safetensors', type: 'VAE', sizeKB: 100 }),
      file({ name: 'd.gguf', quantType: 'Q4_K_M', fp: undefined, sizeKB: 100 }),
    ]);

    expect(duplicates).toEqual([]);
    expect(similar).toEqual([]);
  });

  it('ignores components with no settings to tell them apart', () => {
    const { duplicates, similar } = getFileConflicts([
      file({ name: 'a.safetensors', type: 'Text Encoder', fp: undefined, sizeKB: 100 }),
      file({ name: 'b.safetensors', type: 'Text Encoder', fp: undefined, sizeKB: 100 }),
    ]);

    expect(duplicates).toEqual([]);
    expect(similar).toEqual([]);
  });
});
