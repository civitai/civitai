import { describe, expect, it } from 'vitest';
import { isSafeTensorFormat } from '../training-custom-model';

/**
 * Both spellings of the same fact must pass: the main app reads `'SafeTensor'` off ModelFile
 * metadata, the training studio reads `'safeTensor'` off the orchestrator's FileFormat. Everything
 * else — including `'unknown'` and a missing format — refuses, mirroring checkCustomModel's
 * strictness (anything not positively SafeTensor is not trainable).
 */
describe('isSafeTensorFormat', () => {
  it('accepts both producers’ spellings', () => {
    expect(isSafeTensorFormat('SafeTensor')).toBe(true);
    expect(isSafeTensorFormat('safeTensor')).toBe(true);
  });

  it('refuses every other format, absent included', () => {
    expect(isSafeTensorFormat('PickleTensor')).toBe(false);
    expect(isSafeTensorFormat('pickleTensor')).toBe(false);
    expect(isSafeTensorFormat('unknown')).toBe(false);
    expect(isSafeTensorFormat('diffusers')).toBe(false);
    expect(isSafeTensorFormat('')).toBe(false);
    expect(isSafeTensorFormat(null)).toBe(false);
    expect(isSafeTensorFormat(undefined)).toBe(false);
  });
});
