import { describe, expect, it } from 'vitest';
import { asExpectedText, summariseRuns, type RunRow } from './run-summary';
import type { Expected } from './types';

const PG13_OR_LOWER: Expected = { nsfw: { min: 'none', max: 'pg13' } };
const NOT_SCAM: Expected = { scam: false };

const nsfw = (caseId: number, level: string, expected = PG13_OR_LOWER): RunRow => ({
  caseId,
  expected,
  status: 'ok',
  output: { nsfw: { level } },
});
const scam = (caseId: number, detected: boolean): RunRow => ({
  caseId,
  expected: NOT_SCAM,
  status: 'ok',
  output: { scam: { detected } },
});
const failed = (caseId: number, expected: Expected, error: string): RunRow => ({
  caseId,
  expected,
  status: 'error',
  output: { error },
});

describe('summariseRuns', () => {
  it('counts as-expected cases per label for the current prompts alone', () => {
    const summary = summariseRuns([
      nsfw(1, 'none'),
      nsfw(2, 'r'),
      scam(3, false),
      failed(4, NOT_SCAM, 'Workflow failed'),
    ]);
    expect(summary.labels).toEqual([
      { label: 'nsfw', name: 'Rating', current: { correct: 1, scored: 2 }, changed: null },
      { label: 'scam', name: 'Scam / phishing', current: { correct: 1, scored: 1 }, changed: null },
    ]);
    expect(summary).toMatchObject({ fixed: [], broke: [], errors: { current: 1, changed: null } });
    expect(asExpectedText(summary.labels[0].current!)).toBe('1 of 2 as expected');
  });

  it('lists the cases the changes fixed and broke, in plain words', () => {
    const summary = summariseRuns(
      [nsfw(1, 'r'), nsfw(2, 'pg13'), scam(3, false), nsfw(4, 'none')],
      [nsfw(1, 'pg13'), nsfw(2, 'x'), scam(3, false), failed(4, PG13_OR_LOWER, 'timed out')]
    );
    expect(summary.labels[0]).toEqual({
      label: 'nsfw',
      name: 'Rating',
      current: { correct: 2, scored: 3 },
      changed: { correct: 1, scored: 2 },
    });
    expect(summary.fixed).toEqual([
      {
        caseId: 1,
        label: 'nsfw',
        expected: 'PG-13 or lower',
        current: 'Rated R',
        changed: 'Rated PG-13',
      },
    ]);
    expect(summary.broke).toEqual([
      {
        caseId: 2,
        label: 'nsfw',
        expected: 'PG-13 or lower',
        current: 'Rated PG-13',
        changed: 'Rated X',
      },
    ]);
    // Case 4 errored with the changes: neither fixed nor broken.
    expect(summary.errors).toEqual({ current: 0, changed: 1 });
  });

  it('shows a label scored on only one side', () => {
    const summary = summariseRuns([failed(1, NOT_SCAM, 'x')], [scam(1, true)]);
    expect(summary.labels).toEqual([
      {
        label: 'scam',
        name: 'Scam / phishing',
        current: null,
        changed: { correct: 0, scored: 1 },
      },
    ]);
    expect(summary.broke).toEqual([]);
  });
});
