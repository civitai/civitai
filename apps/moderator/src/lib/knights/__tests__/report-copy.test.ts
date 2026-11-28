import { describe, expect, it } from 'vitest';
import { reportBreakdown, trialsCount } from '../report-copy';

describe('reportBreakdown', () => {
  it('names the only reason without a number', () => {
    expect(reportBreakdown({ image: 1, question: 0 })).toBe(
      'Reported by 1 player: problem with the image'
    );
    expect(reportBreakdown({ image: 0, question: 5 })).toBe(
      'Reported by 5 players: problem with the question'
    );
  });

  it('counts each reason when both were given, and never shows a zero', () => {
    expect(reportBreakdown({ image: 4, question: 2 })).toBe(
      'Reported by 6 players: 4 problem with the image, 2 problem with the question'
    );
    expect(reportBreakdown({ image: 0, question: 1 })).not.toContain('0');
  });
});

describe('trialsCount', () => {
  it('uses the singular for one', () => {
    expect(trialsCount('questions', 1)).toBe('question');
    expect(trialsCount('questions', 2)).toBe('questions');
    expect(trialsCount('questions', 0)).toBe('questions');
    expect(trialsCount('yes-no', 1)).toBe('pair');
    expect(trialsCount('spot-check', 1)).toBe('image to spot-check');
  });
});
