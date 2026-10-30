import { describe, expect, it } from 'vitest';
import { consensusRule, decideYesNo } from './decide';

const votes = (yes: number, no: number) => [
  ...Array.from({ length: yes }, () => ({ answer: 'yes' })),
  ...Array.from({ length: no }, () => ({ answer: 'no' })),
];
const rule = { needed: 5, max: 8 };

describe('decideYesNo', () => {
  it('waits until enough have answered', () => {
    expect(decideYesNo(votes(3, 1), rule)).toEqual({ kind: 'pending' });
  });

  it('settles on the majority once enough have answered, one vote each', () => {
    expect(decideYesNo(votes(3, 2), rule)).toEqual({ kind: 'consensus', value: 'yes' });
    expect(decideYesNo(votes(1, 4), rule)).toEqual({ kind: 'consensus', value: 'no' });
  });

  it('treats a tie as no outcome and keeps asking, until the cap gives it up', () => {
    expect(decideYesNo(votes(3, 3), { needed: 4, max: 8 })).toEqual({ kind: 'pending' });
    expect(decideYesNo(votes(4, 4), { needed: 4, max: 8 })).toEqual({ kind: 'exhausted' });
  });

  it('prefers a majority over the cap', () => {
    expect(decideYesNo(votes(5, 3), { needed: 4, max: 8 })).toEqual({
      kind: 'consensus',
      value: 'yes',
    });
  });

  it('ignores answers that are not on offer', () => {
    expect(decideYesNo([{ answer: '4' }, ...votes(2, 2)], { needed: 5, max: 9 })).toEqual({
      kind: 'pending',
    });
  });
});

describe('consensusRule', () => {
  it('takes the consensus size and the cap as the axis question says', () => {
    expect(consensusRule({ votesToResolve: 3, maxVotes: 9 })).toEqual({ needed: 3, max: 9 });
  });

  it('treats a cap below the consensus size as the consensus size, and says so', () => {
    const warn: string[] = [];
    expect(consensusRule({ votesToResolve: 5, maxVotes: 2 }, (m) => warn.push(m))).toEqual({
      needed: 5,
      max: 5,
    });
    expect(warn).toHaveLength(1);
  });
});
