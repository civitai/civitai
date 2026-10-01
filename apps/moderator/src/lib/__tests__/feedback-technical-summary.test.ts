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

  it('groups a four-figure count, so it cannot sit beside a grouped number unread', () => {
    // `plural` routes through `num`; pinned here because the badge is the one place these counts
    // appear next to the panel's own grouped totals.
    expect(feedbackTechnicalSummary({ consoleErrors: consoleErrors(1000), networkErrors: [] })).toBe(
      '1,000 distinct console errors'
    );
  });
});
