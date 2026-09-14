import { describe, expect, it } from 'vitest';

import {
  BLOCK_POST_DETAIL_MAX,
  BLOCK_POST_MAX_IMAGES,
  BLOCK_POST_MAX_TAGS,
  BLOCK_POST_TITLE_MAX,
  normalizeBlockPostTagNames,
  resolveWorkflowOutputSelection,
  validateBlockPostText,
} from '~/server/services/blocks/block-post.logic';

/**
 * The PURE half of the App-Blocks → Post bridge.
 *
 * Every expectation below is a LITERAL, derived from the rule the function is
 * supposed to implement — never from reading the implementation back. Where a
 * bound is involved the case is built from the exported constant ± 1 so it stays
 * correct if the constant moves, AND a second case pins a value the constant
 * cannot equal, so a mutant that hardcodes the constant's own value cannot
 * survive.
 */
describe('validateBlockPostText', () => {
  it('trims, and collapses empty/whitespace to null rather than an empty string', () => {
    expect(validateBlockPostText({ title: '  hello  ', detail: '\n world \n' })).toEqual({
      ok: true,
      title: 'hello',
      detail: 'world',
    });
    expect(validateBlockPostText({ title: '   ', detail: '' })).toEqual({
      ok: true,
      title: null,
      detail: null,
    });
    expect(validateBlockPostText({})).toEqual({ ok: true, title: null, detail: null });
  });

  it('accepts a title of exactly the cap and refuses one character more', () => {
    const atCap = 'a'.repeat(BLOCK_POST_TITLE_MAX);
    expect(validateBlockPostText({ title: atCap })).toEqual({
      ok: true,
      title: atCap,
      detail: null,
    });
    const overCap = 'a'.repeat(BLOCK_POST_TITLE_MAX + 1);
    expect(validateBlockPostText({ title: overCap })).toEqual({
      ok: false,
      reason: `title exceeds ${BLOCK_POST_TITLE_MAX} characters`,
    });
  });

  it('accepts a detail of exactly the cap and refuses one character more', () => {
    const atCap = 'b'.repeat(BLOCK_POST_DETAIL_MAX);
    expect(validateBlockPostText({ detail: atCap }).ok).toBe(true);
    expect(validateBlockPostText({ detail: 'b'.repeat(BLOCK_POST_DETAIL_MAX + 1) })).toEqual({
      ok: false,
      reason: `detail exceeds ${BLOCK_POST_DETAIL_MAX} characters`,
    });
  });

  it('the two bounds are INDEPENDENT — a 1000-char detail is fine, a 1000-char title is not', () => {
    // 1000 is chosen because it is > TITLE_MAX and < DETAIL_MAX, so a mutant that
    // applied one bound to both fields dies here. Neither literal equals either
    // constant, so the case cannot be satisfied by hardcoding a constant.
    const text = 'c'.repeat(1000);
    expect(validateBlockPostText({ detail: text }).ok).toBe(true);
    expect(validateBlockPostText({ title: text }).ok).toBe(false);
  });

  describe('link refusal — a sandboxed app must not publish outbound links as the viewer', () => {
    it.each([
      ['https://evil.example/claim', 'an https scheme'],
      ['http://evil.example', 'an http scheme'],
      ['visit www.somewhere.test now', 'a bare www host'],
      ['dm me at freebuzz.click', 'a schemeless domain with a risky TLD'],
      ['see civitai.com/x', 'a schemeless domain with a common TLD'],
    ])('refuses detail containing %j (%s)', (detail) => {
      expect(validateBlockPostText({ detail })).toEqual({
        ok: false,
        reason: 'detail may not contain links',
      });
    });

    it('refuses a link in the TITLE too, with the title-specific reason', () => {
      // A guard that only screened `detail` would pass this. The distinct reason
      // string is what proves WHICH branch fired — a shared message would let the
      // detail branch take credit for the title case.
      expect(validateBlockPostText({ title: 'free buzz at https://evil.example' })).toEqual({
        ok: false,
        reason: 'title may not contain links',
      });
    });

    it('does NOT refuse ordinary prose that merely contains dots or a slash', () => {
      // The refusal must not be so broad that normal copy is unpublishable —
      // otherwise the control gets removed rather than respected.
      const ok = validateBlockPostText({
        title: 'Study no. 4',
        detail: 'Rendered at 1024x1024. Steps 30/cfg 7. Mood: calm, a bit eerie...',
      });
      expect(ok.ok).toBe(true);
    });
  });
});

describe('normalizeBlockPostTagNames', () => {
  it('lowercases, trims, drops empties and non-strings', () => {
    expect(
      normalizeBlockPostTagNames(['  Anime ', 'PORTRAIT', '', '   ', 42, null, undefined])
    ).toEqual(['anime', 'portrait']);
  });

  it('dedupes case-insensitively BEFORE applying the cap', () => {
    // The order matters: a cap applied before dedupe would let one repeated name
    // consume the whole budget. Six names, five distinct → all five survive.
    expect(normalizeBlockPostTagNames(['a', 'A', 'b', 'c', 'd', 'e'])).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it(`caps at ${BLOCK_POST_MAX_TAGS} distinct names, keeping the first ones`, () => {
    const many = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
    const out = normalizeBlockPostTagNames(many);
    expect(out).toHaveLength(BLOCK_POST_MAX_TAGS);
    expect(out).toEqual(many.slice(0, BLOCK_POST_MAX_TAGS));
  });

  it('drops an absurdly long name rather than truncating it', () => {
    expect(normalizeBlockPostTagNames(['x'.repeat(101), 'ok'])).toEqual(['ok']);
  });

  it('returns [] for a non-array', () => {
    expect(normalizeBlockPostTagNames('anime')).toEqual([]);
    expect(normalizeBlockPostTagNames(undefined)).toEqual([]);
  });
});

describe('resolveWorkflowOutputSelection', () => {
  it('defaults to every available index when none are requested', () => {
    expect(
      resolveWorkflowOutputSelection({ requested: undefined, availableCount: 3, maxCount: 20 })
    ).toEqual([0, 1, 2]);
  });

  it('preserves REQUEST order, not sorted order', () => {
    // Post order is the viewer-visible consequence, so request order is the
    // contract. A mutant that sorted would look correct on [0,1,2].
    expect(
      resolveWorkflowOutputSelection({ requested: [2, 0, 1], availableCount: 3, maxCount: 20 })
    ).toEqual([2, 0, 1]);
  });

  it('drops out-of-range, negative, non-integer and duplicate indexes', () => {
    expect(
      resolveWorkflowOutputSelection({
        requested: [0, 0, -1, 2, 7, 1.5, 1],
        availableCount: 3,
        maxCount: 20,
      })
    ).toEqual([0, 2, 1]);
  });

  it('stops at maxCount', () => {
    // maxCount 3 against 10 available: deliberately NOT a divisor or multiple of
    // the default cap, so a mutant substituting BLOCK_POST_MAX_IMAGES dies.
    expect(
      resolveWorkflowOutputSelection({ requested: undefined, availableCount: 10, maxCount: 3 })
    ).toEqual([0, 1, 2]);
    expect(BLOCK_POST_MAX_IMAGES).not.toBe(3);
  });

  it('returns [] when nothing valid was asked for', () => {
    expect(
      resolveWorkflowOutputSelection({ requested: [9, 10], availableCount: 2, maxCount: 20 })
    ).toEqual([]);
    expect(
      resolveWorkflowOutputSelection({ requested: undefined, availableCount: 0, maxCount: 20 })
    ).toEqual([]);
  });
});
