import { describe, expect, it } from 'vitest';
import { isBlockedCustomModel, isSafeTensorFormat } from '../training-custom-model';

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

describe('isBlockedCustomModel', () => {
  it('blocks every version of a blocked model, in either AIR form', () => {
    expect(isBlockedCustomModel('urn:air:anima:checkpoint:civitai:2855007@3224434')).toBe(true);
    expect(isBlockedCustomModel('urn:air:anima:checkpoint:civitai:2855007@9999999')).toBe(true);
    expect(isBlockedCustomModel(' civitai:2855007@3224434 ')).toBe(true);
    expect(isBlockedCustomModel('urn:air:sd1:checkpoint:civitai:53761@285757')).toBe(true);
  });

  it('leaves other models alone, including ids that only share digits', () => {
    expect(isBlockedCustomModel('urn:air:anima:checkpoint:civitai:2458426@2945208')).toBe(false);
    expect(isBlockedCustomModel('urn:air:anima:checkpoint:civitai:28550071@1')).toBe(false);
    expect(isBlockedCustomModel('urn:air:anima:checkpoint:civitai:1@2855007')).toBe(false);
    expect(isBlockedCustomModel('anima')).toBe(false);
  });
});
