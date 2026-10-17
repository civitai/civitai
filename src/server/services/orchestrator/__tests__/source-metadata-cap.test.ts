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

  it('accepts ordinary metadata and no metadata', () => {
    expect(() => assertSourceMetadataWithinCap(undefined, undefined)).not.toThrow();
    expect(() =>
      assertSourceMetadataWithinCap(
        { params: { prompt: 'a cat', steps: 30 }, resources: [{ id: 1, strength: 1 }] },
        { 'https://a/1.png': { params: { prompt: 'a dog' } } }
      )
    ).not.toThrow();
  });

  it('refuses metadata that repeats one object past the cap without serializing it', () => {
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
