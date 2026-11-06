import { describe, expect, it } from 'vitest';
import { appealVerdict } from '../appeal-split';

describe('appealVerdict', () => {
  it('rejects the appeal when every label is upheld', () => {
    expect(appealVerdict({ minor: 'uphold', poi: 'uphold' })).toEqual({
      verdict: 'Rejected',
      lifted: [],
      perLabel: null,
    });
  });

  it('approves it, with no per-label split, when every label is overturned', () => {
    expect(appealVerdict({ minor: 'overturn' })).toEqual({
      verdict: 'Approved',
      lifted: ['minor'],
      perLabel: null,
    });
  });

  it('approves it for the lifted label only when the labels differ', () => {
    expect(appealVerdict({ minor: 'uphold', poi: 'overturn' })).toEqual({
      verdict: 'Approved',
      lifted: ['poi'],
      perLabel: { minor: 'uphold', poi: 'overturn' },
    });
  });
});
