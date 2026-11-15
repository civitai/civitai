import { describe, expect, it } from 'vitest';
import { feedbackTechnicalSummary } from '$lib/feedback-technical-summary';

/**
 * Real behavioural coverage, unlike its neighbour `feedback-panel-tripwires.test.ts` — this calls
 * the function and reads what it returns. That is the whole reason the badge is a pure function
 * rather than an expression in the `<summary>`: this app has no Svelte tier, so logic written in a
 * component is logic nothing can assert.
 *
 * Expected strings are written out literally rather than built from `plural`, so a defect in
 * `plural` cannot cancel out against the same defect in the expectation.
 */

/** Distinct messages, as the producer stores them — `count` is occurrences of that one message. */
const consoleErrors = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ message: `boom ${i}`, count: i + 1 }));

/** Deliberately a mix of 4xx/5xx and an opaque 0 — the badge counts rows, not statuses. */
const networkErrors = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://example.invalid/${i}`,
    status: [404, 500, 0][i % 3],
    initiatorType: 'fetch',
  }));

describe('feedbackTechnicalSummary', () => {
  it('is null when there is nothing to report, so no element renders', () => {
    expect(feedbackTechnicalSummary({ consoleErrors: [], networkErrors: [] })).toBeNull();
  });

  it('counts console errors as DISTINCT, never as occurrences', () => {
    // 3 messages that fired 1, 2 and 3 times — six events. The badge must say 3, and must say
    // "distinct", because `FeedbackBrowserErrors` spells its own heading that way and a badge
    // disagreeing with the heading three lines below it is worse than no badge.
    const context = { consoleErrors: consoleErrors(3), networkErrors: [] };
    expect(context.consoleErrors.reduce((sum, e) => sum + e.count, 0)).toBe(6);
    expect(feedbackTechnicalSummary(context)).toBe('3 distinct console errors');
  });

  it('agrees with its noun at one', () => {
    expect(feedbackTechnicalSummary({ consoleErrors: consoleErrors(1), networkErrors: [] })).toBe(
      '1 distinct console error'
    );
    expect(feedbackTechnicalSummary({ consoleErrors: [], networkErrors: networkErrors(1) })).toBe(
      '1 failed request'
    );
  });

  it('reports failed requests alone', () => {
    expect(feedbackTechnicalSummary({ consoleErrors: [], networkErrors: networkErrors(2) })).toBe(
      '2 failed requests'
    );
  });

  it('joins both, console first — the order the sections render in', () => {
    expect(
      feedbackTechnicalSummary({ consoleErrors: consoleErrors(3), networkErrors: networkErrors(1) })
    ).toBe('3 distinct console errors · 1 failed request');
  });

  it('formats a five-figure count rather than printing raw digits', () => {
    // Asserted as "not the raw number", never as a literal `12,345`: `plural` routes through `num`,
    // which is `toLocaleString()` with no locale, so a literal pins this suite to one machine's.
    // `format.test.ts` already ruled on this and this borrows its form — including its MAGNITUDE.
    //
    // 🔴 FIVE FIGURES, NOT FOUR, AND THAT IS THE WHOLE POINT OF THE NUMBER. CLDR
    // `minimumGroupingDigits` is 2 in a large minority of locales, so `1000` legitimately renders
    // UNGROUPED there and `not.toBe('1000 …')` is false — measured, the whole suite went
    // 1 failed / 1253 passed under `LC_ALL=es_ES.UTF-8`, and es/pl/it/pt/bg/hu/lv all do it.
    // At five figures every locale sampled groups, which is why `format.test.ts` picked 12345.
    // 🔴 A `de_DE` control CANNOT see this: German groups at four figures, so the locale the
    // previous round controlled against was structurally blind to the defect it was checking for.
    const out = feedbackTechnicalSummary({
      consoleErrors: consoleErrors(12345),
      networkErrors: [],
    });
    expect(out).not.toBe('12345 distinct console errors');
    expect(out).toMatch(/^\d[\d\s,. ]*\d distinct console errors$/);
  });
});
