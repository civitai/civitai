import { describe, expect, it } from 'vitest';
import { extractHashCandidates } from '~/server/services/generation/generation.service';

/**
 * `resolveImageMeta` is a publicProcedure and its schema is `z.record(z.string(), z.unknown())`, so
 * every value below arrives exactly as an anonymous caller wrote it. The `Record<string, string>`
 * cast in extractResourceInputFromMeta is unchecked, and get_image_resources.sql — the SQL this
 * function mirrors — cannot hit any of these, because jsonb_each_text yields NULL where a value is
 * not text and LOWER(NULL) is NULL.
 */
const asInput = (meta: Record<string, unknown>) =>
  ({
    resources: Array.isArray(meta.resources)
      ? (meta.resources as { hash?: string }[]).filter((r) => r.hash)
      : undefined,
    hashes: meta.hashes,
    modelHash: meta['Model hash'],
    modelName: meta.Model,
    civitaiResources: undefined,
  } as Parameters<typeof extractHashCandidates>[0]);

describe('extractHashCandidates', () => {
  it('does not throw when meta.hashes carries a non-string value', () => {
    // Reverting the fix throws TypeError: value.toLowerCase is not a function, which surfaces as a
    // 500 on an unauthenticated procedure rather than as a failed assertion.
    expect(() => extractHashCandidates(asInput({ hashes: { model: null } }))).not.toThrow();
    expect(() => extractHashCandidates(asInput({ hashes: { model: 12345 } }))).not.toThrow();
    expect(() => extractHashCandidates(asInput({ hashes: { model: { a: 1 } } }))).not.toThrow();
  });

  it('yields no candidate for a non-string or empty hash, in any of the three stages', () => {
    expect(extractHashCandidates(asInput({ hashes: { model: null } }))).toEqual([]);
    expect(extractHashCandidates(asInput({ hashes: { model: '' } }))).toEqual([]);
    expect(extractHashCandidates(asInput({ resources: [{ type: 'model', hash: '' }] }))).toEqual(
      []
    );
    expect(extractHashCandidates(asInput({ 'Model hash': '' }))).toEqual([]);
    expect(extractHashCandidates(asInput({ 'Model hash': 42 }))).toEqual([]);
  });

  it('still yields the candidates it should', () => {
    expect(extractHashCandidates(asInput({ hashes: { model: 'ABC123' } }))).toEqual([
      { hash: 'abc123', name: 'model', strength: null },
    ]);
    expect(
      extractHashCandidates(asInput({ resources: [{ type: 'model', hash: 'DEF456' }] }))
    ).toEqual([{ hash: 'def456', name: 'model', strength: null }]);
    expect(extractHashCandidates(asInput({ 'Model hash': 'FED987', Model: 'thing' }))).toEqual([
      { hash: 'fed987', name: 'thing', strength: null },
    ]);
  });

  it('keeps rejecting the empty-content hash and non-resource roles', () => {
    expect(extractHashCandidates(asInput({ hashes: { model: 'e3b0c44298fc' } }))).toEqual([]);
    expect(extractHashCandidates(asInput({ hashes: { llamamodel: 'abc123' } }))).toEqual([]);
  });
});
