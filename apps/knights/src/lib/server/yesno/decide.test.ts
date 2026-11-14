import { describe, expect, it } from 'vitest';
import { consensusRule, decideYesNo } from './decide';

const votes = (yes: number, no: number) => [
  ...Array.from({ length: yes }, () => ({ answer: 'yes', weight: 1 })),
  ...Array.from({ length: no }, () => ({ answer: 'no', weight: 1 })),
];
const held = (yes: number, no: number) => votes(yes, no).map((v) => ({ ...v, weight: 0 }));
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

  it('never reaches the cap with the default 5 to resolve and 10 at most: five answers cannot tie', () => {
    const defaults = { needed: 5, max: 10 };
    for (let yes = 0; yes <= 5; yes++) {
      expect(decideYesNo(votes(yes, 5 - yes), defaults).kind).toBe('consensus');
    }
  });

  it('is decided by the next answer after a tie, so the cap is only reached when it equals the consensus size', () => {
    const rule4 = { needed: 4, max: 8 };
    expect(decideYesNo(votes(2, 2), rule4)).toEqual({ kind: 'pending' });
    expect(decideYesNo(votes(3, 2), rule4)).toEqual({ kind: 'consensus', value: 'yes' });
    expect(decideYesNo(votes(2, 3), rule4)).toEqual({ kind: 'consensus', value: 'no' });
    expect(decideYesNo(votes(2, 2), { needed: 4, max: 4 })).toEqual({ kind: 'exhausted' });
  });

  it('prefers a majority over the cap', () => {
    expect(decideYesNo(votes(5, 3), { needed: 4, max: 8 })).toEqual({
      kind: 'consensus',
      value: 'yes',
    });
  });

  it('does not count a weight-0 answer toward the size, the majority or the cap', () => {
    expect(decideYesNo([...votes(2, 2), ...held(1, 0)], rule)).toEqual({ kind: 'pending' });
    expect(decideYesNo(held(9, 0), rule)).toEqual({ kind: 'pending' });
    expect(decideYesNo([...votes(3, 2), ...held(0, 4)], rule)).toEqual({
      kind: 'consensus',
      value: 'yes',
    });
    expect(decideYesNo([...votes(3, 3), ...held(2, 2)], { needed: 4, max: 6 })).toEqual({
      kind: 'exhausted',
    });
    expect(decideYesNo([...votes(2, 2), ...held(2, 2)], { needed: 4, max: 6 })).toEqual({
      kind: 'pending',
    });
  });

  it('ignores answers that are not on offer', () => {
    expect(
      decideYesNo([{ answer: '4', weight: 1 }, ...votes(2, 2)], { needed: 5, max: 9 })
    ).toEqual({
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
