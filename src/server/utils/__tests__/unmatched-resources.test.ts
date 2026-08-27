import { isEqual } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import type { DetectedResource } from '~/server/utils/unmatched-resources';
import { deriveUnmatchedResources } from '~/server/utils/unmatched-resources';

const detected = (over: Partial<DetectedResource>): DetectedResource => ({
  modelversionid: null,
  name: null,
  hash: null,
  detected: true,
  ...over,
});

describe('deriveUnmatchedResources', () => {
  it('surfaces a resource detected only via meta.hashes, with no meta.resources entry', () => {
    // The reported bug: an unpublished local LoRA reaches get_image_resources() through the
    // meta.hashes union branch, so nothing in meta.resources can carry a flag for it.
    const result = deriveUnmatchedResources(
      [
        detected({ name: 'Some Checkpoint', hash: 'aabbccddee', modelversionid: 42 }),
        detected({ name: 'lycoris:my-turbo-lora', hash: '0123456789ab' }),
      ],
      [{ type: 'model', name: 'Some Checkpoint', hash: 'aabbccddee' }]
    );

    expect(result).toHaveLength(1);
    // toStrictEqual, not toEqual: an absent `type` key and `type: undefined` are different here —
    // the latter cannot survive jsonb and would make the caller rewrite meta on every run.
    expect(result[0]).toStrictEqual({ hash: '0123456789ab', name: 'my-turbo-lora' });
  });

  it('accounts for every unmatched resource when one is named and one is orphaned', () => {
    const result = deriveUnmatchedResources(
      [
        detected({ name: 'detail-tweaker', hash: 'ffffffffffff' }),
        detected({ name: 'checkpoint:nameless-orphan', hash: 'aaaaaaaaaaaa' }),
      ],
      [{ type: 'lycoris', name: 'detail-tweaker.safetensors', hash: 'FFFFFFFFFFFF' }]
    );

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name)).toEqual(['detail-tweaker', 'nameless-orphan']);
    expect(result[0].type).toBe('lycoris');
  });

  it('ignores resources that resolved to a model version', () => {
    const result = deriveUnmatchedResources([
      detected({ name: 'matched', hash: 'abcdef0123', modelversionid: 7 }),
    ]);

    expect(result).toEqual([]);
  });

  it('drops junk values that meta.hashes carries alongside real hashes', () => {
    const result = deriveUnmatchedResources([
      detected({ name: 'manual1', hash: 'false' }),
      detected({ name: 'manual1', hash: ' ' }),
      detected({ name: 'model', hash: '' }),
      detected({ name: 'manual1', hash: 'abc' }),
      detected({ name: 'manual1', hash: 'b166b8' }),
      detected({ name: 'nothash', hash: 'zzzzzzzzzz' }),
      detected({ name: 'real', hash: 'b166b8931f32' }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].hash).toBe('b166b8931f32');
  });

  it('excludes hashless detections', () => {
    const result = deriveUnmatchedResources([detected({ name: 'prompt-embedding', hash: null })]);

    expect(result).toEqual([]);
  });

  it('dedupes by hash across detection branches', () => {
    // meta.resources and meta.hashes both report the same LoRA
    const result = deriveUnmatchedResources([
      detected({ name: 'my-lora', hash: 'abcdef012345' }),
      detected({ name: 'lora:my-lora', hash: 'ABCDEF012345' }),
    ]);

    expect(result).toHaveLength(1);
  });

  it('normalises an uppercase detected hash rather than discarding it as junk', () => {
    // HASH_SHAPE only matches lowercase, so a missing toLowerCase() here drops the row entirely.
    // The dedupe test above cannot catch that: there, the uppercase row is the duplicate.
    const result = deriveUnmatchedResources([detected({ name: 'solo', hash: 'ABCDEF012345' })]);

    expect(result).toHaveLength(1);
    expect(result[0].hash).toBe('abcdef012345');
  });

  it('ignores rows the function returns as not detected', () => {
    const result = deriveUnmatchedResources([
      detected({ name: 'post model version', hash: 'aabbccddeeff', detected: false }),
    ]);

    expect(result).toEqual([]);
  });

  it('equals its own stored form, so the caller does not rewrite meta on every run', () => {
    // jsonb cannot hold undefined. A `type: undefined` key survives in memory but not through
    // storage, so carrying one makes isEqual false forever and rewrites Image.meta every call.
    const derived = deriveUnmatchedResources([
      detected({ name: 'lora:orphan-with-no-type', hash: 'aabbccddeeff' }),
    ]);
    const stored = JSON.parse(JSON.stringify(derived));

    expect(isEqual(derived, stored)).toBe(true);
  });

  it('returns a stable order regardless of detection order', () => {
    // get_image_resources() has no ORDER BY, and the caller compares arrays positionally.
    const rows = [
      detected({ name: 'zebra', hash: 'cccccccccccc' }),
      detected({ name: 'alpha', hash: 'aaaaaaaaaaaa' }),
      detected({ name: 'middle', hash: 'bbbbbbbbbbbb' }),
    ];

    const forward = deriveUnmatchedResources(rows);
    const reversed = deriveUnmatchedResources([...rows].reverse());

    expect(forward.map((r) => r.name)).toEqual(['alpha', 'middle', 'zebra']);
    expect(isEqual(forward, reversed)).toBe(true);
  });

  it('always produces a name, so no consumer has to handle a missing label', () => {
    const sha256 = 'a'.repeat(64);
    const result = deriveUnmatchedResources([detected({ name: 'lycoris:', hash: sha256 })]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('a'.repeat(12));
  });

  it('prefers the meta.resources name and strips path and extension', () => {
    const result = deriveUnmatchedResources(
      [detected({ name: 'lora:ugly_key_name', hash: '112233445566' })],
      [{ type: 'lora', name: 'C:\\models\\Pretty Name.safetensors', hash: '112233445566' }]
    );

    expect(result[0].name).toBe('Pretty Name');
  });
});
