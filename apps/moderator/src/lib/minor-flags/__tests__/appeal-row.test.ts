import { describe, expect, it } from 'vitest';
import { clipList, pastAppealsText } from '../appeal-row';

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
