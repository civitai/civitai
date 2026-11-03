import { describe, expect, it } from 'vitest';
import { BLOCK_REASONS, asksBlockReason, blockReasonProblem } from './block-reasons';

describe('blockReasonProblem', () => {
  it('lists the five reasons of the original game, in order', () => {
    expect(BLOCK_REASONS.map((r) => r.label)).toEqual([
      'Inappropriate Minors',
      'Realistic Minors',
      'Depicts Real Person',
      'Bestiality',
      'Other',
    ]);
  });

  it('wants a listed reason on Blocked and none on any other answer', () => {
    expect(blockReasonProblem('32', undefined)).toBe('required');
    expect(blockReasonProblem('32', '')).toBe('required');
    expect(blockReasonProblem('32', 'Nope')).toBe('invalid');
    expect(blockReasonProblem('32', 'Bestiality')).toBeNull();
    expect(blockReasonProblem('8', 'Other')).toBe('unexpected');
    expect(blockReasonProblem('8', null)).toBeNull();
    expect(blockReasonProblem('yes', '')).toBeNull();
  });
});

describe('asksBlockReason', () => {
  it('asks only on the rating question, the one question the server pairs a reason with', () => {
    expect(asksBlockReason('knights.image.nsfwLevel')).toBe(true);
    expect(asksBlockReason('knights.image.minor')).toBe(false);
    expect(asksBlockReason(undefined)).toBe(false);
  });
});
