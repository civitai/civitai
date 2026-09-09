import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { clampToColumn } from '~/server/clickhouse/tracker';

/**
 * `pageViews` was the last table still losing rows to the ClickHouse tracker's silent
 * client-side rejection, and unlike the six enum gaps before it the cause was INTEGER
 * WIDTH OVERFLOW: a value too large for its column destroys the whole row while the
 * fire-and-forget POST still reports success.
 *
 * 🔴 The expectations here are LITERAL, taken from the production rows that were actually
 * rejected (read out of the dead-letter queue on 2026-09-08) and from the ClickHouse type
 * bounds — never derived from the implementation they test.
 */

const UINT32_MAX = 4_294_967_295;
const INT16_MAX = 32_767;

describe('clampToColumn', () => {
  it('passes through a value the column can hold', () => {
    expect(clampToColumn(13_178, UINT32_MAX)).toBe(13_178);
    expect(clampToColumn(1_920, INT16_MAX)).toBe(1_920);
  });

  it('accepts the exact ceiling unchanged', () => {
    // The off-by-one that would matter in the SAFE direction: clamping the boundary
    // itself would corrupt legitimate maximum values on every row.
    expect(clampToColumn(UINT32_MAX, UINT32_MAX)).toBe(UINT32_MAX);
    expect(clampToColumn(INT16_MAX, INT16_MAX)).toBe(INT16_MAX);
  });

  it('clamps one past the ceiling', () => {
    // The other half of the pair. Together these two pin the boundary exactly; either
    // alone is satisfied by an implementation off by one.
    expect(clampToColumn(UINT32_MAX + 1, UINT32_MAX)).toBe(UINT32_MAX);
    expect(clampToColumn(INT16_MAX + 1, INT16_MAX)).toBe(INT16_MAX);
  });

  describe('the real rejected production values', () => {
    // Each of these destroyed a real pageViews row. Pinning the actual numbers means a
    // regression is reported in the terms of the incident, not as an abstract bound.
    const rejectedDurations = [
      4_323_369_542, // smallest observed overflow — only 0.66% over the ceiling
      4_742_447_225,
      5_271_443_941,
      12_434_883_238, // largest observed — ~2.9x the ceiling
    ];
    it.each(rejectedDurations)('duration %d becomes the UInt32 ceiling', (value: number) => {
      expect(value).toBeGreaterThan(UINT32_MAX); // the fixture is genuinely a violation
      expect(clampToColumn(value, UINT32_MAX)).toBe(UINT32_MAX);
    });

    const rejectedDimensions = [51_600, 100_000, 102_000, 183_800, 211_900];
    it.each(rejectedDimensions)(
      'window dimension %d becomes the Int16 ceiling',
      (value: number) => {
        expect(value).toBeGreaterThan(INT16_MAX);
        expect(clampToColumn(value, INT16_MAX)).toBe(INT16_MAX);
      }
    );
  });

  it('collapses non-finite input to 0 rather than emitting NaN', () => {
    // NaN would be rejected by the integer column exactly like an oversized value, so
    // letting it through would leave the row-destroying bug in place for a new input.
    //
    // +Infinity deliberately becomes 0, NOT the ceiling. Saturating it would assert
    // "the longest duration the column can express", which is a measurement claim; a
    // non-finite input is a broken measurement, and 0 reads as "no data" instead of
    // silently manufacturing a maximum. Pinned so the choice cannot drift unnoticed.
    expect(clampToColumn(Number.NaN, UINT32_MAX)).toBe(0);
    expect(clampToColumn(Number.POSITIVE_INFINITY, UINT32_MAX)).toBe(0);
    expect(clampToColumn(Number.NEGATIVE_INFINITY, UINT32_MAX)).toBe(0);
  });

  it('collapses negatives to 0 — the unsigned column cannot hold them', () => {
    expect(clampToColumn(-1, UINT32_MAX)).toBe(0);
    expect(clampToColumn(-99_999, INT16_MAX)).toBe(0);
  });

  it('truncates a non-integer', () => {
    expect(clampToColumn(1_920.75, INT16_MAX)).toBe(1_920);
  });
});

describe('pageView emits through the clamp', () => {
  // A behavioural test would need the whole tracker/session/actor apparatus. What can
  // break WITHOUT that, and what actually reintroduces the bug, is the wiring: the raw
  // values getting back into the emitted object. So this pins the wiring structurally.
  //
  // 🔴 This asserts a RELATIONSHIP (raw values unreachable at the emit site), not the
  // presence of a word — a guard that merely checked for the string "clampToColumn"
  // would pass while `...values` silently reinstated the raw fields after it.
  // Resolved from this file's own location, matching tracker-enum-drift.test.ts. A
  // cwd-relative path would silently read a different tree when the runner's cwd moves.
  const source = fs.readFileSync(path.resolve(__dirname, '../tracker.ts'), 'utf-8');
  const start = source.indexOf('public pageView(');
  // Bound the slice at the NEXT method, not at the first `\n  }`. The first version used
  // that and silently matched the `  }) {` that closes pageView's own PARAMETER type, so
  // emitBlock was the signature alone and every assertion below ran against an empty
  // string. It failed loudly here rather than passing vacuously, which is the only reason
  // it was caught — a `.not.toContain` check would have gone green on that empty slice.
  const after = source.slice(start);
  const nextMember = after.slice(1).search(/\n {2}(public|private|protected) /);
  const rawBlock = nextMember === -1 ? after : after.slice(0, nextMember + 1);

  // 🔴 Strip comments before asserting on CODE. The prose above this method explains the
  // hazard by quoting `...values` verbatim, so a raw `.not.toContain('...values')` matched
  // the COMMENT and failed against a correct implementation — a grep cannot tell code from
  // prose. (This repo has hit that exact shape before, counting `as ReactionType` in a
  // docstring that explained its own removal.)
  // Block comments are stripped as well as line comments. An earlier version handled
  // only `//`, so rewriting the hazard comment as JSDoc would have made the
  // `.not.toContain('...values')` assertion below fail against correct code — the very
  // defect this stripper was added to fix, reintroduced in a different comment syntax.
  const emitBlock = rawBlock
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  it('positive control: the comment stripper is not eating the code', () => {
    // Without this, a stripper bug that returned '' would make every `.not.toContain`
    // below pass vacuously — the failure mode that makes a negative assertion worthless.
    //
    // 🔴 It asserts the CODE SURVIVED, never that a comment was removed. An earlier
    // version also required `emitBlock.length < rawBlock.length`, which coupled suite
    // health to the presence of at least one `//` line inside the method: deleting only
    // the comments, leaving the destructure and all three clamps byte-identical, turned
    // the suite RED against a correct implementation. A guard that fails on correct code
    // is worse than no guard — it trains the reader to ignore it.
    expect(emitBlock).toContain('public pageView(');
    expect(emitBlock).toContain('return this.send(');
    expect(emitBlock).toContain('clampToColumn(');
    expect(emitBlock.length).toBeGreaterThan(200);
  });

  it('clamps all three narrow columns', () => {
    expect(emitBlock).toContain('duration: clampToColumn(duration, UINT32_MAX)');
    expect(emitBlock).toContain('windowWidth: clampToColumn(windowWidth, INT16_MAX)');
    expect(emitBlock).toContain('windowHeight: clampToColumn(windowHeight, INT16_MAX)');
  });

  it('does NOT spread the raw values object into the emitted row', () => {
    // `...values` would carry unclamped duration/windowWidth/windowHeight, making the
    // clamp depend on key order. The method destructures them out into `...rest`
    // instead, so the raw fields cannot be reached at the emit site at all.
    expect(emitBlock).not.toContain('...values');
    expect(emitBlock).toContain('...rest');
    expect(emitBlock).toContain('const { duration, windowWidth, windowHeight, ...rest } = values;');
  });

  it('the ledger of clamped fields matches the narrow columns exactly', () => {
    // Fails if the set GROWS or SHRINKS. A new narrow column added to pageViews without
    // a clamp, or a clamp quietly dropped, both land here rather than in production.
    const clamped = [...emitBlock.matchAll(/(\w+): clampToColumn\(/g)].map((m) => m[1]).sort();
    expect(clamped).toEqual(['duration', 'windowHeight', 'windowWidth']);
  });
});
