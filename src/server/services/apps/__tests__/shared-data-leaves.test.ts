import { describe, expect, it } from 'vitest';

import {
  collectSharedDataLeaves,
  SHARED_DATA_MAX_CHARS,
  SHARED_DATA_MAX_DEPTH,
  SHARED_DATA_MAX_LEAVES,
  stripFormatChars,
} from '../shared-data-leaves';

/**
 * The walker decides WHAT moderation reads in a shared row's `data` blob. Anything it skips is
 * unmoderated, so the cases below are the shapes an app (or someone writing through one) can use
 * to put text where a naive `typeof v === 'string'` scan would not look.
 *
 * Fixtures are round-tripped through JSON first, because that is the contract: the router hands
 * the walker the stored form.
 */
const stored = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

function leavesOf(value: unknown) {
  const result = collectSharedDataLeaves(stored(value));
  if (!('leaves' in result)) throw new Error(`unexpected overflow: ${result.overflow}`);
  return result.leaves;
}

/** `depth` nested arrays around one string: depth 1 is `['x']`. */
function nested(depth: number, leaf = 'deep text') {
  let value: unknown = leaf;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

describe('collectSharedDataLeaves — what counts as a leaf', () => {
  it('collects string values and skips numbers, booleans and null', () => {
    const leaves = leavesOf({ a: 'hello', n: 7, f: 1.5, t: true, z: null, arr: [1, false, 'x'] });
    expect(leaves.filter((l) => l.kind === 'value').map((l) => l.raw)).toEqual(['hello', 'x']);
  });

  it('collects OBJECT KEYS as leaves, so text hidden in a key is read', () => {
    const leaves = leavesOf({ tags: { 'a hidden phrase': 1 } });
    expect(leaves).toContainEqual(
      expect.objectContaining({ raw: 'a hidden phrase', kind: 'key', path: 'tags/a hidden phrase' })
    );
  });

  it('walks arrays of objects, keys and values alike', () => {
    const leaves = leavesOf({ items: [{ label: 'first' }, { label: 'second', extra: 'third' }] });
    expect(leaves.map((l) => [l.raw, l.path, l.kind])).toEqual([
      ['items', 'items', 'key'],
      ['label', 'items/0/label', 'key'],
      ['first', 'items/0/label', 'value'],
      // the second `label` key is a duplicate; an object's keys are read before its values
      ['extra', 'items/1/extra', 'key'],
      ['second', 'items/1/label', 'value'],
      ['third', 'items/1/extra', 'value'],
    ]);
  });

  it('dedupes exact strings — first path wins, every occurrence counted (values and keys together)', () => {
    const leaves = leavesOf({ a: 'same', b: ['same', 'same'], c: { same: 0 } });
    const same = leaves.find((l) => l.raw === 'same');
    expect(same).toMatchObject({ path: 'a', kind: 'value', count: 4 });
    expect(leaves.filter((l) => l.raw === 'same')).toHaveLength(1);
  });

  it('reads a bare string, and returns nothing for an absent blob or a scalar', () => {
    expect(leavesOf('just text')).toEqual([
      { raw: 'just text', text: 'just text', path: '', kind: 'value', count: 1 },
    ]);
    expect(collectSharedDataLeaves(undefined)).toEqual({ leaves: [] });
    expect(leavesOf(42)).toEqual([]);
  });

  it('collects a `__proto__` key that JSON.parse made an own property', () => {
    const leaves = collectSharedDataLeaves(JSON.parse('{"__proto__": "inside proto"}'));
    expect('leaves' in leaves && leaves.leaves.map((l) => l.raw)).toEqual([
      '__proto__',
      'inside proto',
    ]);
  });

  it('escapes `/` and `~` in a key so a key cannot forge another path', () => {
    const [key] = leavesOf({ 'a/b~c': 'v' });
    expect(key.path).toBe('a~1b~0c');
  });

  it('reads a leaf 20 arrays deep', () => {
    expect(leavesOf(nested(20)).map((l) => l.raw)).toEqual(['deep text']);
  });
});

describe('collectSharedDataLeaves — format characters', () => {
  it('keeps the raw leaf and hands checks a copy with every \\p{Cf} removed', () => {
    const raw = 'lo​li ‍word⁠s﻿ ­soft';
    const [leaf] = leavesOf({ x: raw }).filter((l) => l.kind === 'value');
    expect(leaf.raw).toBe(raw);
    expect(leaf.text).toBe('loli words soft');
  });

  it('also strips the invisibles that are NOT \\p{Cf}: Hangul filler, grapheme joiner, variation selectors', () => {
    const raw = 'lo\u3164li lo\u034Fli lo\uFE0Fli lo\u{E0100}li';
    const [leaf] = leavesOf({ x: raw }).filter((l) => l.kind === 'value');
    expect(leaf.text).toBe('loli loli loli loli');
  });

  it('strips format characters from keys too', () => {
    const [key] = leavesOf({ 'hid​den': 1 });
    expect(key).toMatchObject({ raw: 'hid​den', text: 'hidden', kind: 'key' });
  });

  it('stripFormatChars leaves ordinary text and other categories alone', () => {
    expect(stripFormatChars('plain text, émoji 🙂 and\ttabs')).toBe(
      'plain text, émoji 🙂 and\ttabs'
    );
  });
});

describe('collectSharedDataLeaves — caps report overflow instead of truncating', () => {
  it.each([
    [SHARED_DATA_MAX_DEPTH - 1, true],
    [SHARED_DATA_MAX_DEPTH, true],
    [SHARED_DATA_MAX_DEPTH + 1, false],
  ])('depth %i → within cap: %s', (depth, ok) => {
    const result = collectSharedDataLeaves(stored(nested(depth)));
    expect(result).toEqual(
      ok ? { leaves: [expect.objectContaining({ raw: 'deep text' })] } : { overflow: 'depth' }
    );
  });

  it('pins the depth cap at 32', () => {
    expect(SHARED_DATA_MAX_DEPTH).toBe(32);
  });

  it('counts object nesting the same as array nesting', () => {
    let value: unknown = 'leaf';
    for (let i = 0; i < SHARED_DATA_MAX_DEPTH + 1; i++) value = { k: value };
    expect(collectSharedDataLeaves(stored(value))).toEqual({ overflow: 'depth' });
  });

  it.each([
    [SHARED_DATA_MAX_LEAVES - 1, true],
    [SHARED_DATA_MAX_LEAVES, true],
    [SHARED_DATA_MAX_LEAVES + 1, false],
  ])('%i distinct leaves → within cap: %s', (count, ok) => {
    const value = Array.from({ length: count }, (_, i) => `leaf-${i}`);
    const result = collectSharedDataLeaves(stored(value));
    if (ok) expect('leaves' in result && result.leaves).toHaveLength(count);
    else expect(result).toEqual({ overflow: 'leaves' });
  });

  it('pins the leaf cap at 1000, and counts KEYS toward it', () => {
    expect(SHARED_DATA_MAX_LEAVES).toBe(1000);
    const value = Object.fromEntries(
      Array.from({ length: SHARED_DATA_MAX_LEAVES / 2 + 1 }, (_, i) => [`k${i}`, `v${i}`])
    );
    expect(collectSharedDataLeaves(stored(value))).toEqual({ overflow: 'leaves' });
  });

  it('duplicates do not count toward the leaf cap', () => {
    const value = Array.from({ length: SHARED_DATA_MAX_LEAVES * 3 }, () => 'repeated');
    expect(collectSharedDataLeaves(stored(value))).toEqual({
      leaves: [expect.objectContaining({ raw: 'repeated', count: SHARED_DATA_MAX_LEAVES * 3 })],
    });
  });

  it.each([
    [SHARED_DATA_MAX_CHARS - 1, true],
    [SHARED_DATA_MAX_CHARS, true],
    [SHARED_DATA_MAX_CHARS + 1, false],
  ])('%i total leaf chars → within cap: %s', (total, ok) => {
    // Two distinct strings so the cap is a SUM, not a per-leaf limit.
    const first = 'a'.repeat(Math.floor(total / 2));
    const second = 'b'.repeat(total - first.length);
    const result = collectSharedDataLeaves(stored([first, second]));
    if (ok) expect('leaves' in result && result.leaves).toHaveLength(2);
    else expect(result).toEqual({ overflow: 'chars' });
  });

  it('pins the chars cap at 64000, and counts KEY characters toward it', () => {
    expect(SHARED_DATA_MAX_CHARS).toBe(64_000);
    const key = 'k'.repeat(SHARED_DATA_MAX_CHARS / 2);
    const value = 'v'.repeat(SHARED_DATA_MAX_CHARS / 2 + 1);
    expect(collectSharedDataLeaves(stored({ [key]: value }))).toEqual({ overflow: 'chars' });
  });

  it('a duplicated long string counts once toward the chars cap', () => {
    const long = 'x'.repeat(SHARED_DATA_MAX_CHARS - 10);
    expect(collectSharedDataLeaves(stored([long, long, long]))).toEqual({
      leaves: [expect.objectContaining({ count: 3 })],
    });
  });
});
