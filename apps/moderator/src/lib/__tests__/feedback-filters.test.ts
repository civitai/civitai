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
 * 🔴 THE DECODE IS GUARDED ON `area` AS WELL AS `key`, AND THAT IS THE POINT OF IT. A bare
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
    // And under an area no producer has ever written.
    expect(formatFeedbackFilterValue('some-future-area', 'browsingLevel', 28).text).toBe('28');
  });

  /**
   * 🔴 THE NUMERIC CASE IS THE ONLY ONE THAT CAN SEE THE MUTANT, and it is here deliberately.
   * `formatBrowsingLevel` rejects anything that is not a non-negative int4, so a STRING fixture falls
   * through the decoder whether or not the key half of the guard exists — `'newest'`, `'none'` and
   * `''` all render identically with `key === 'browsingLevel'` deleted. Measured in this round:
   * dropping the key half left every string case green and was killed by nothing in this block.
   * A number under a non-`browsingLevel` key is what makes the assertion reachable.
   */
  it('leaves a different key alone under the decoded area', () => {
    expect(formatFeedbackFilterValue('bitdex-image-feed', 'sort', 'newest').text).toBe('newest');
    expect(formatFeedbackFilterValue('bitdex-image-feed', 'category', 'none').text).toBe('(none)');
    expect(formatFeedbackFilterValue('bitdex-image-feed', 'query', '').text).toBe('—');
    // 28 is a value the decoder renders as `R, X, XXX`, so this cannot pass by coincidence.
    expect(formatFeedbackFilterValue('bitdex-image-feed', 'resultCount', 28)).toEqual({
      text: '28',
      title: null,
    });
  });

  /**
   * 🔴 THE BYTE-IDENTICAL PIN, over the triples LISTED BELOW — with their EXACT rendered output
   * hand-typed. This table is what makes the removal of the former two-level `(area, key)` formatter
   * registry a refactor rather than a behaviour change: if any input in it renders differently from
   * the registry's output, one of these rows moves.
   *
   * ⚠️ IT IS NOT AN ENUMERATION OF EVERYTHING THE PANEL CAN BE HANDED, and an earlier version of
   * this comment said it was. `context.filters` is a schemaless JSONB blob and `area` is a stored
   * TEXT column, so the true population is open by construction — it includes whatever historical
   * producers wrote, not only what live ones write. The round-1 audit read production and found two
   * shapes this table had missed on the `bitdex-image-feed` rows: a `period` key (a string,
   * `'AllTime'`), present on all 23 of them, and `sort` values shaped `'Most Collected'` rather than
   * the `'newest'` used below. Both render generically either way — that is why nothing behaved
   * wrongly — and both are now rows here. The lesson the sentence had to lose is the general one:
   * this is a fixed list of cases, and a claim of completeness over an open set cannot be kept true.
   *
   * What the list does cover, and why each part is in it:
   *   - `area` ∈ `FEEDBACK_AREAS` — `bitdex-image-feed`, `apps-marketplace`, `site-bug-report` —
   *     plus an unknown slug, since the column is free text.
   *   - the keys live producers write: `kind`, `category`, `sort`, `query`
   *     (`src/components/Apps/appsStoreFeedbackContext.ts`). `FeedbackDrawer.tsx` writes `path`
   *     only, which is not a `filters` entry at all.
   *   - `browsingLevel`, which no live producer writes: it exists only on those 23 historical
   *     `bitdex-image-feed` rows, because BitDex was decommissioned 2026-09-01.
   *   - the two historical shapes named above.
   */
  const reachable: Array<[string, string, string | number | boolean, string, string | null]> = [
    // area                key              value      text            title
    ['bitdex-image-feed', 'browsingLevel', 1, 'PG', '1'],
    ['bitdex-image-feed', 'browsingLevel', 3, 'PG, PG-13', '3'],
    ['bitdex-image-feed', 'browsingLevel', 7, 'PG, PG-13, R', '7'],
    ['bitdex-image-feed', 'browsingLevel', 28, 'R, X, XXX', '28'],
    ['bitdex-image-feed', 'browsingLevel', 30, 'PG-13, R, X, XXX', '30'],
    ['bitdex-image-feed', 'browsingLevel', 31, 'PG, PG-13, R, X, XXX', '31'],
    // The same key on every other area: untouched, including the sentinels.
    ['apps-marketplace', 'browsingLevel', 28, '28', null],
    ['site-bug-report', 'browsingLevel', 28, '28', null],
    ['some-future-area', 'browsingLevel', 28, '28', null],
    // The keys live producers actually write, on the area that writes them.
    ['apps-marketplace', 'kind', 'all', 'all', null],
    ['apps-marketplace', 'kind', 'installed', 'installed', null],
    ['apps-marketplace', 'category', 'none', '(none)', null],
    ['apps-marketplace', 'category', 'productivity', 'productivity', null],
    ['apps-marketplace', 'sort', 'newest', 'newest', null],
    ['apps-marketplace', 'query', '', '—', null],
    ['apps-marketplace', 'query', 'upscale', 'upscale', null],
    // And those same keys under the decoded area, which must not pick up the decode.
    ['bitdex-image-feed', 'category', 'none', '(none)', null],
    ['bitdex-image-feed', 'query', '', '—', null],
    ['bitdex-image-feed', 'sort', 'newest', 'newest', null],
    // The two shapes the round-1 audit read off the live rows: a `period` key this table had never
    // held, and BitDex's own `sort` vocabulary, which is nothing like the marketplace's. Both sit on
    // the ONE area that decodes, which is the only place a key-scoping slip could reach them.
    ['bitdex-image-feed', 'period', 'AllTime', 'AllTime', null],
    ['bitdex-image-feed', 'sort', 'Most Collected', 'Most Collected', null],
    // A non-string value on an undecoded key still stringifies.
    ['site-bug-report', 'nsfw', true, 'true', null],
    ['site-bug-report', 'page', 4, '4', null],
  ];

  it.each(reachable)('renders (%s, %s, %s) as exactly %s', (area, key, value, text, title) => {
    expect(formatFeedbackFilterValue(area, key, value)).toEqual({ text, title });
  });

  /**
   * ⚠️ AN INVARIANT GUARD, NOT REGRESSION COVERAGE — labelled as one rather than counted as the other.
   *
   * When this file held a two-level `(area, key)` registry these cases pinned a LIVE hazard: indexed
   * into a plain object, `'toString'` and `'constructor'` resolve to inherited FUNCTIONS, and
   * `formatter?.(value)` CALLS one. The registry is gone — the decode is now two `===` comparisons,
   * which have no prototype chain — so **this guard no longer has a live hazard behind it**, and it
   * would pass with the guard's own reason deleted. It is kept only because `area` and `key` remain
   * untrusted (a TEXT column and a schemaless JSONB blob), so a future edit that reintroduces a keyed
   * lookup here — which must then be a `Map` — fails here instead of shipping.
   */
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'renders the inherited key %s generically, on either axis',
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

  it('falls back to generic rendering when the decoder declines the value', () => {
    // The decoded `(area, key)`, but a value no browsing level could be: the panel must show the
    // string, not a confident `?`.
    expect(formatFeedbackFilterValue('bitdex-image-feed', 'browsingLevel', 'all')).toEqual({
      text: 'all',
      title: null,
    });
  });
});
