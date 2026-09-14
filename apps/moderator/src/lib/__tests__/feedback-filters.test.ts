import { describe, expect, it } from 'vitest';
import {
  formatBrowsingLevel,
  formatFeedbackFilterValue,
  genericFilterValue,
} from '$lib/feedback-filters';

/**
 * 🔴 `browsingLevel` IS A BITMASK. The failure this file exists to stop is a `browsingLevelLabels[v]`
 * lookup, which is right for `1` and silently wrong for every composite — and every value production
 * actually carries except `1` is a composite.
 *
 * The fixtures below are the values MEASURED on live `bitdex-image-feed` rows: 1, 3, 7, 28, 30, 31.
 * They are used rather than invented ones because a hand-picked set can accidentally agree with a
 * broken decode; these are the exact inputs the panel has to get right.
 */
describe('formatBrowsingLevel', () => {
  // Hand-typed, not derived from `browsingLevelLabels` — deriving the expectation from the table the
  // implementation reads would make this test agree with itself.
  const production: Array<[number, string]> = [
    [1, 'PG'],
    [3, 'PG, PG-13'],
    [7, 'PG, PG-13, R'],
    [28, 'R, X, XXX'],
    [30, 'PG-13, R, X, XXX'],
    [31, 'PG, PG-13, R, X, XXX'],
  ];

  it.each(production)('decodes the production value %i to %s', (value, expected) => {
    expect(formatBrowsingLevel(value)).toEqual({ text: expected, title: String(value) });
  });

  it('keeps the raw number available, because a moderator has to match it against a row', () => {
    expect(formatBrowsingLevel(28)?.title).toBe('28');
  });

  /**
   * Every fixture above is a DIFFERENT string, so a mutant that hardcodes any one of them dies on the
   * other five. Asserted rather than left implicit: a table whose rows can coincide cannot see that
   * class of mutant at all.
   */
  it('the six expectations are pairwise distinct, or five of them are testing nothing', () => {
    const rendered = production.map(([, expected]) => expected);
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('renders 0 as the shared "no level recorded" marker rather than an empty string', () => {
    expect(formatBrowsingLevel(0)).toEqual({ text: '?', title: '0' });
  });

  /**
   * 🔴 An unknown bit must be VISIBLE and must not take the known bits with it. Dropping it would
   * narrow the report silently — the moderator would read `PG` for a value that also carried
   * something this app has never heard of.
   */
  it('keeps the known bits and shows an unknown one, rather than dropping either', () => {
    // 1 | 64: PG, plus a bit no label covers.
    expect(formatBrowsingLevel(65)).toEqual({ text: 'PG, +64', title: '65' });
    // The known half survives on its own terms, not just as a substring of something longer.
    expect(formatBrowsingLevel(65)?.text.startsWith('PG')).toBe(true);
  });

  it('renders a value made only of unknown bits without crashing', () => {
    expect(formatBrowsingLevel(64)).toEqual({ text: '+64', title: '64' });
  });

  it('includes Blocked, which is a real bit and not an unknown one', () => {
    expect(formatBrowsingLevel(33)).toEqual({ text: 'PG, Blocked', title: '33' });
  });

  /**
   * 🔴 The FALL-THROUGH contract. `null` means "this is not a browsing level, render it generically",
   * and it is what stops the panel printing a confident `?` over a value that is plainly something
   * else. `context` is JSONB with no schema at rest, so any of these can turn up.
   */
  it.each([
    ['a string', '28'],
    ['a boolean', true],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a value past int4', 0x80000000],
  ] as Array<[string, string | number | boolean]>)('falls through on %s', (_label, value) => {
    expect(formatBrowsingLevel(value)).toBeNull();
  });

  it('accepts the largest value an int4 column can hold', () => {
    expect(formatBrowsingLevel(0x7fffffff)).not.toBeNull();
  });
});

describe('genericFilterValue', () => {
  it('keeps the sentinel renderings the panel has always had', () => {
    // `'none'` is the marketplace builder's "no category selected"; `''` is an empty search box.
    expect(genericFilterValue('none')).toEqual({ text: '(none)', title: null });
    expect(genericFilterValue('')).toEqual({ text: '—', title: null });
  });

  it('stringifies everything else and discloses no separate raw value', () => {
    expect(genericFilterValue('onsite')).toEqual({ text: 'onsite', title: null });
    expect(genericFilterValue(42)).toEqual({ text: '42', title: null });
    expect(genericFilterValue(false)).toEqual({ text: 'false', title: null });
  });
});

/**
 * 🔴 THE REGISTRY IS SCOPED BY `(area, key)`, AND THAT IS THE POINT OF IT. A global
 * `if (key === 'browsingLevel')` would relabel a future area's identically-named value as a content
 * rating — a wrong answer that reads exactly like a right one, on a queue whose whole job is telling
 * a moderator what a reporter saw.
 */
describe('formatFeedbackFilterValue', () => {
  it('decodes browsingLevel on the area that actually emits it', () => {
    expect(formatFeedbackFilterValue('bitdex-image-feed', 'browsingLevel', 28).text).toBe(
      'R, X, XXX'
    );
  });

  it('leaves the SAME key alone under a different area', () => {
    expect(formatFeedbackFilterValue('apps-marketplace', 'browsingLevel', 28)).toEqual({
      text: '28',
      title: null,
    });
    expect(formatFeedbackFilterValue('site-bug-report', 'browsingLevel', 28).text).toBe('28');
    // And under an area nobody has registered at all.
    expect(formatFeedbackFilterValue('some-future-area', 'browsingLevel', 28).text).toBe('28');
  });

  it('leaves a different key alone under the registered area', () => {
    expect(formatFeedbackFilterValue('bitdex-image-feed', 'sort', 'newest').text).toBe('newest');
    expect(formatFeedbackFilterValue('bitdex-image-feed', 'category', 'none').text).toBe('(none)');
    expect(formatFeedbackFilterValue('bitdex-image-feed', 'query', '').text).toBe('—');
  });

  /**
   * 🔴 BOTH LOOKUP KEYS ARE UNTRUSTED — `area` is a stored TEXT column, `key` comes out of a JSONB
   * blob with no schema at rest. Indexed into a plain object, `'toString'` and `'constructor'` return
   * inherited FUNCTIONS, `formatter?.(value)` calls one, and the panel renders whatever came back.
   * The implementation uses `Map`, which has no prototype chain; this pins the behaviour so a future
   * "simplify it to a record" edit fails here instead of shipping.
   */
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'does not resolve the inherited key %s as a formatter, on either axis',
    (hostile) => {
      expect(formatFeedbackFilterValue(hostile, 'browsingLevel', 28)).toEqual({
        text: '28',
        title: null,
      });
      expect(formatFeedbackFilterValue('bitdex-image-feed', hostile, 28)).toEqual({
        text: '28',
        title: null,
      });
      expect(formatFeedbackFilterValue(hostile, hostile, 28)).toEqual({ text: '28', title: null });
    }
  );

  it('falls back to generic rendering when the registered formatter declines the value', () => {
    // Registered `(area, key)`, but a value no browsing level could be: the panel must show the
    // string, not a confident `?`.
    expect(formatFeedbackFilterValue('bitdex-image-feed', 'browsingLevel', 'all')).toEqual({
      text: 'all',
      title: null,
    });
  });
});
