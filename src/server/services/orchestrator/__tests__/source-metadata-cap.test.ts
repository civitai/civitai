import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSourceMetadataWithinCap,
  SOURCE_METADATA_MAX_CHARS,
} from '~/server/services/orchestrator/source-metadata-cap';

const TOO_LARGE = { code: 'PAYLOAD_TOO_LARGE', message: 'sourceMetadata is too large' };

/** `{ params: { prompt } }` whose JSON is exactly `length` characters. */
const ofLength = (length: number) => ({
  params: { prompt: 'x'.repeat(length - '{"params":{"prompt":""}}'.length) },
});

describe('assertSourceMetadataWithinCap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts metadata at the cap and refuses one character over, counting both fields', () => {
    expect(JSON.stringify(ofLength(SOURCE_METADATA_MAX_CHARS)).length).toBe(
      SOURCE_METADATA_MAX_CHARS
    );
    expect(() =>
      assertSourceMetadataWithinCap(ofLength(SOURCE_METADATA_MAX_CHARS), undefined)
    ).not.toThrow();
    expect(() =>
      assertSourceMetadataWithinCap(ofLength(SOURCE_METADATA_MAX_CHARS + 1), undefined)
    ).toThrow(expect.objectContaining(TOO_LARGE));
    // Split across the two fields, the total is what is capped.
    const half = ofLength(SOURCE_METADATA_MAX_CHARS / 2);
    expect(() => assertSourceMetadataWithinCap(half, { 'https://a/1.png': half })).toThrow(
      expect.objectContaining(TOO_LARGE)
    );
  });

  it('accepts metadata with more values than the default walk budget when its JSON fits', () => {
    // 300,000 values in ~600 KB: more than the default walk budget, within this one.
    const sourceMetadataMap = {
      'https://a/1.png': { params: { seeds: new Array(300_000).fill(0) } },
    };
    expect(() => assertSourceMetadataWithinCap(undefined, sourceMetadataMap)).not.toThrow();
  });

  it('refuses metadata with more than 1,048,576 values', () => {
    const at = { 'https://a/1.png': { s: new Array(1024 * 1024 - 4).fill(0) } };
    expect(() => assertSourceMetadataWithinCap(undefined, at)).not.toThrow();
    const over = { 'https://a/1.png': { s: new Array(1024 * 1024).fill(0) } };
    expect(() => assertSourceMetadataWithinCap(undefined, over)).toThrow(
      expect.objectContaining(TOO_LARGE)
    );
  });

  it('accepts ordinary metadata and no metadata', () => {
    expect(() => assertSourceMetadataWithinCap(undefined, undefined)).not.toThrow();
    expect(() =>
      assertSourceMetadataWithinCap(
        { params: { prompt: 'a cat', steps: 30 }, resources: [{ id: 1, strength: 1 }] },
        { 'https://a/1.png': { params: { prompt: 'a dog' } } }
      )
    ).not.toThrow();
  });

  it('refuses metadata far over the cap without serializing it', () => {
    const node = { prompt: 'x'.repeat(10_000) };
    const map = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, i) => [`https://a/${i}.png`, { params: node }])
    );
    const stringify = JSON.stringify;
    let stringified = 0;
    vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof stringify>) => {
      const out = stringify(...args);
      stringified += out?.length ?? 0;
      return out;
    });
    expect(() => assertSourceMetadataWithinCap(undefined, map)).toThrow(
      expect.objectContaining(TOO_LARGE)
    );
    expect(stringified).toBe(0);
  });
});
