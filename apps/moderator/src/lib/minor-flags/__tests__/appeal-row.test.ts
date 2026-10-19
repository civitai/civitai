import { describe, expect, it } from 'vitest';
import { clipList, pastAppealsText, shortHash, yearMonth } from '../appeal-row';

describe('pastAppealsText', () => {
  it('lists only the non-zero statuses', () => {
    expect(pastAppealsText({ approved: 1, rejected: 2, void: 0, pending: 0 })).toBe(
      '1 approved, 2 rejected'
    );
  });
  it('says none when there is no history', () => {
    expect(pastAppealsText({ approved: 0, rejected: 0, void: 0, pending: 0 })).toBe('none');
  });
});

describe('clipList', () => {
  it('reports the overflow', () => {
    expect(clipList([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2, 3], more: 2 });
    expect(clipList([1], 3)).toEqual({ shown: [1], more: 0 });
  });
  it('counts the overflow against the full length when the list itself was capped', () => {
    expect(clipList([1, 2, 3, 4, 5], 3, 40)).toEqual({ shown: [1, 2, 3], more: 37 });
  });
});

describe('shortHash', () => {
  it('keeps the first four and last three characters', () => {
    expect(shortHash('9f3c0d1e2b7a21')).toBe('9f3c…a21');
  });
  it('leaves a hash too short to shorten as it is', () => {
    expect(shortHash('9f3ca21')).toBe('9f3ca21');
  });
});

describe('yearMonth', () => {
  it('formats a date as year and month', () => {
    expect(yearMonth('2025-11-04T10:00:00.000Z')).toBe('2025-11');
    expect(yearMonth(new Date('2024-03-31T12:00:00.000Z'))).toBe('2024-03');
  });
});
