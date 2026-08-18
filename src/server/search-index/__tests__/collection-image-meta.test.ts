import { describe, expect, it } from 'vitest';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { parseCollectionImageMeta } from '~/server/search-index/collection-image-meta';

/**
 * Meilisearch flattens nested objects into dotted field names and assigns each distinct
 * name a permanent, index-wide field id out of a u16 space (65,536). Widening this
 * whitelist to any field whose KEYS come from user data exhausts that space and breaks
 * every write to collections_v3 — so these tests assert the shipped key set is fixed and
 * bounded, not merely that the happy path works.
 */
const SHIPPED_KEYS = ['prompt'];

const flattenFieldNames = (value: unknown, prefix = ''): string[] => {
  if (Array.isArray(value)) return value.flatMap((entry) => flattenFieldNames(entry, prefix));
  if (value === null || typeof value !== 'object') return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, entry]) =>
    flattenFieldNames(entry, prefix ? `${prefix}.${key}` : key)
  );
};

const richMeta = {
  prompt: 'a cat sitting on a fence',
  negativePrompt: 'blurry',
  baseModel: 'SDXL 1.0',
  cfgScale: 7,
  steps: 30,
  sampler: 'Euler a',
  seed: 12345,
  clipSkip: 2,
  engine: 'comfy',
  workflow: 'txt2img',
  hashes: { model: 'abc123', 'lora:Detail Tweaker': 'def456', 'embed:BadHands': 'ghi789' },
  effects: { 'some effect': { nested: { deeper: true } } },
  external: { source: { name: 'elsewhere' }, details: { runId: 'r-1', tier: 2 } },
  resources: [{ type: 'lora', name: 'Detail Tweaker', weight: 0.8, hash: 'def456' }],
  civitaiResources: [{ type: 'lora', modelVersionId: 99, weight: 0.8 }],
  additionalResources: [{ name: 'x', type: 'lora', strength: 1, air: 'urn:air:x' }],
  comfy: '{"nodes":[]}',
} as unknown as ImageMetaProps;

describe('parseCollectionImageMeta', () => {
  it('ships prompt and drops every other generation field', () => {
    const shipped = Object.keys(parseCollectionImageMeta(richMeta));
    const unexpected = shipped.filter((key) => !SHIPPED_KEYS.includes(key));

    expect(
      unexpected,
      'these keys reach collections_v3 and permanently consume Meilisearch field ids'
    ).toEqual([]);
    expect(parseCollectionImageMeta(richMeta)).toEqual({ prompt: richMeta.prompt });
  });

  it('mints a bounded number of field names even when meta carries thousands of keys', () => {
    const hashes = Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [`lora:generated-name-${i}`, `hash-${i}`])
    );
    const effects = Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [`effect-${i}`, { strength: i }])
    );

    const fieldNames = flattenFieldNames(
      parseCollectionImageMeta({ prompt: 'x', hashes, effects } as unknown as ImageMetaProps)
    );

    expect(fieldNames.length).toBeLessThanOrEqual(SHIPPED_KEYS.length);
    expect(fieldNames).toEqual(['prompt']);
  });

  it('returns an empty object for missing or malformed meta', () => {
    expect(parseCollectionImageMeta(null as unknown as ImageMetaProps)).toEqual({});
    expect(parseCollectionImageMeta('not an object' as unknown as ImageMetaProps)).toEqual({});
    expect(
      flattenFieldNames(parseCollectionImageMeta({ hashes: { a: 'b' } } as unknown as ImageMetaProps))
    ).toEqual([]);
  });
});
