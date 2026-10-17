import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSourceMetadataWithinCap,
  SOURCE_METADATA_MAX_CHARS,
} from '~/server/services/orchestrator/source-metadata-cap';

const TOO_LARGE = { code: 'PAYLOAD_TOO_LARGE', message: 'sourceMetadata is too large' };
// The cap as a literal (17 MiB), so the boundary cases cannot follow a constant that drifts.
const CAP = 17 * 1024 * 1024;
const repoRoot = path.resolve(__dirname, '../../../../..');

/** `{ params: { prompt } }` whose JSON is exactly `length` characters. */
const ofLength = (length: number) => ({
  params: { prompt: 'x'.repeat(length - '{"params":{"prompt":""}}'.length) },
});

describe('assertSourceMetadataWithinCap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the cap equal to the tRPC route body limit', () => {
    expect(SOURCE_METADATA_MAX_CHARS).toBe(CAP);
    const route = readFileSync(path.join(repoRoot, 'src/pages/api/trpc/[trpc].ts'), 'utf8');
    const limits = [...route.matchAll(/sizeLimit:\s*'(\d+)mb'/g)].map((m) => Number(m[1]));
    expect(limits).toEqual([CAP / (1024 * 1024)]);
  });

  it('accepts metadata at the cap and refuses one character over, counting both fields', () => {
    expect(JSON.stringify(ofLength(CAP)).length).toBe(CAP);
    expect(() => assertSourceMetadataWithinCap(ofLength(CAP - 1), undefined)).not.toThrow();
    expect(() => assertSourceMetadataWithinCap(ofLength(CAP), undefined)).not.toThrow();
    expect(() => assertSourceMetadataWithinCap(ofLength(CAP + 1), undefined)).toThrow(
      expect.objectContaining(TOO_LARGE)
    );
    // Split across the two fields, the total is what is capped.
    const half = ofLength(CAP / 2);
    expect(() => assertSourceMetadataWithinCap(half, { 'https://a/1.png': half })).toThrow(
      expect.objectContaining(TOO_LARGE)
    );
  });

  it('accepts a large batch: 300 images of 600-value metadata', () => {
    // About 405 counted values per entry, so roughly 120,000 in all: a batch well past any real
    // one, under the 262,144 budget. The budget's exact edge is pinned by the case below.
    const entry = () => ({
      params: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p${i}`, i])),
      resources: Array.from({ length: 100 }, (_, i) => ({ id: i })),
    });
    const sourceMetadataMap = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`https://a/${i}.png`, entry()])
    );
    expect(() => assertSourceMetadataWithinCap(undefined, sourceMetadataMap)).not.toThrow();
  });

  it('refuses metadata with more than 262,144 values', () => {
    const at = { 'https://a/1.png': { s: new Array(256 * 1024 - 4).fill(0) } };
    expect(() => assertSourceMetadataWithinCap(undefined, at)).not.toThrow();
    const over = { 'https://a/1.png': { s: new Array(256 * 1024).fill(0) } };
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
