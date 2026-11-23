import { describe, expect, it } from 'vitest';
import { decideYesNo } from './decide';

const votes = (yes: number, no: number) => [
  ...Array.from({ length: yes }, () => ({ answer: 'yes', weight: 1 })),
  ...Array.from({ length: no }, () => ({ answer: 'no', weight: 1 })),
];
const held = (yes: number, no: number) => votes(yes, no).map((v) => ({ ...v, weight: 0 }));

describe('decideYesNo at the Knight stage (4 to settle, 10 at most, 75%)', () => {
  it('waits until four have answered', () => {
    expect(decideYesNo(votes(3, 0), 'Knight')).toEqual({ kind: 'pending' });
  });

  it('settles on four unanimous answers', () => {
    expect(decideYesNo(votes(4, 0), 'Knight')).toEqual({ kind: 'consensus', value: 'yes' });
    expect(decideYesNo(votes(0, 4), 'Knight')).toEqual({ kind: 'consensus', value: 'no' });
  });

  it('keeps asking while the agreement is weak, and settles once one answer holds 75%', () => {
    expect(decideYesNo(votes(3, 1), 'Knight')).toEqual({ kind: 'pending' });
    expect(decideYesNo(votes(3, 2), 'Knight')).toEqual({ kind: 'pending' });
    expect(decideYesNo(votes(4, 2), 'Knight')).toEqual({ kind: 'pending' });
    expect(decideYesNo(votes(4, 1), 'Knight')).toEqual({ kind: 'consensus', value: 'yes' });
    expect(decideYesNo(votes(2, 6), 'Knight')).toEqual({ kind: 'consensus', value: 'no' });
  });

  it('is exhausted at ten answers without 75%, a plain majority included', () => {
    expect(decideYesNo(votes(5, 5), 'Knight')).toEqual({ kind: 'exhausted' });
    expect(decideYesNo(votes(7, 3), 'Knight')).toEqual({ kind: 'exhausted' });
    expect(decideYesNo(votes(8, 2), 'Knight')).toEqual({ kind: 'consensus', value: 'yes' });
  });
});

describe('decideYesNo at the higher stages', () => {
  it('Templar: three unanimous settle, six without 75% are exhausted', () => {
    expect(decideYesNo(votes(2, 1), 'Templar')).toEqual({ kind: 'pending' });
    expect(decideYesNo(votes(0, 3), 'Templar')).toEqual({ kind: 'consensus', value: 'no' });
    expect(decideYesNo(votes(3, 1), 'Templar')).toEqual({ kind: 'consensus', value: 'yes' });
    expect(decideYesNo(votes(4, 2), 'Templar')).toEqual({ kind: 'exhausted' });
  });

  it('Paladin: two unanimous settle, four without 75% are exhausted', () => {
    expect(decideYesNo(votes(1, 1), 'Paladin')).toEqual({ kind: 'pending' });
    expect(decideYesNo(votes(2, 0), 'Paladin')).toEqual({ kind: 'consensus', value: 'yes' });
    expect(decideYesNo(votes(2, 1), 'Paladin')).toEqual({ kind: 'pending' });
    expect(decideYesNo(votes(2, 2), 'Paladin')).toEqual({ kind: 'exhausted' });
  });
});

describe('what counts as a vote', () => {
  it('does not count a weight-0 answer toward the size, the share or the cap', () => {
    expect(decideYesNo([...votes(3, 0), ...held(0, 3)], 'Knight')).toEqual({ kind: 'pending' });
    expect(decideYesNo(held(9, 0), 'Knight')).toEqual({ kind: 'pending' });
    expect(decideYesNo([...votes(4, 0), ...held(0, 4)], 'Knight')).toEqual({
      kind: 'consensus',
      value: 'yes',
    });
    expect(decideYesNo([...votes(5, 4), ...held(1, 0)], 'Knight')).toEqual({ kind: 'pending' });
  });

  it('counts one vote per player, whatever the stored weight', () => {
    const heavy = [{ answer: 'yes', weight: 3 }, ...votes(0, 3)];
    expect(decideYesNo(heavy, 'Knight')).toEqual({ kind: 'pending' });
  });

  it('ignores answers that are not on offer', () => {
    expect(decideYesNo([{ answer: '4', weight: 1 }, ...votes(3, 0)], 'Knight')).toEqual({
      kind: 'pending',
    });
  });
});

describe('decideYesNo when a "no" may not settle on the minimum (a rating-lowering tag removal)', () => {
  const strict = { noSettlesAtNeeded: false };

  it('keeps two "no" at Paladin pending, then settles at 3-0 or 3-1 and is exhausted at 2-2', () => {
    expect(decideYesNo(votes(0, 2), 'Paladin', strict)).toEqual({ kind: 'pending' });
    expect(decideYesNo(votes(0, 3), 'Paladin', strict)).toEqual({ kind: 'consensus', value: 'no' });
    expect(decideYesNo(votes(1, 2), 'Paladin', strict)).toEqual({ kind: 'pending' });
    expect(decideYesNo(votes(1, 3), 'Paladin', strict)).toEqual({ kind: 'consensus', value: 'no' });
    expect(decideYesNo(votes(2, 2), 'Paladin', strict)).toEqual({ kind: 'exhausted' });
  });

  it('still settles a "yes" on the minimum', () => {
    expect(decideYesNo(votes(2, 0), 'Paladin', strict)).toEqual({
      kind: 'consensus',
      value: 'yes',
    });
  });

  it('leaves the default rule as it was', () => {
    expect(decideYesNo(votes(0, 2), 'Paladin')).toEqual({ kind: 'consensus', value: 'no' });
  });
});
