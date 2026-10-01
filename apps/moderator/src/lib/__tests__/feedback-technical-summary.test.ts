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

  it('formats a four-figure count rather than printing raw digits', () => {
    // Asserted as "not the raw number", never as a literal `1,000`: `plural` routes through `num`,
    // which is `toLocaleString()` with no locale, so a literal pins this suite to one machine's —
    // measured, `LC_ALL=de_DE.UTF-8` turns it into `1.000`. `format.test.ts` already ruled on this
    // and this borrows its form. Restating `toLocaleString()` in the expectation would be worse
    // still: that derives the answer from the implementation and then passes whatever it does.
    const out = feedbackTechnicalSummary({ consoleErrors: consoleErrors(1000), networkErrors: [] });
    expect(out).not.toBe('1000 distinct console errors');
    expect(out).toMatch(/^\d[\d\s,. ]*\d distinct console errors$/);
  });
});
