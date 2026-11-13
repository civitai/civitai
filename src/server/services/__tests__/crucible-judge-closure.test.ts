import { describe, expect, it } from 'vitest';
import {
  decidedPairKeys,
  impliedPairKeys,
  MAX_CLOSURE_VOTES,
} from '~/server/services/crucible-judge-closure';

const sorted = (keys: Iterable<string>) => [...keys].sort();

describe('impliedPairKeys', () => {
  it('decides A-C from A>B and B>C', () => {
    expect(impliedPairKeys(['1>2', '2>3']).has('1:3')).toBe(true);
  });

  it('follows a chain of any length', () => {
    expect(sorted(impliedPairKeys(['1>2', '2>3', '3>4']))).toEqual(
      sorted(['1:2', '1:3', '1:4', '2:3', '2:4', '3:4'])
    );
  });

  it('decides nothing two losses to one winner do not settle', () => {
    // 1>2 and 1>3 say nothing about 2 against 3.
    expect(impliedPairKeys(['1>2', '1>3']).has('2:3')).toBe(false);
  });

  // Deliberate: a pair the judge's own votes reach both ways is a contradiction, and serving it
  // again is how it gets resolved. Do not "simplify" this into skipping every pair in a cycle.
  it('leaves a pair the votes reach both ways undecided', () => {
    const implied = impliedPairKeys(['1>2', '2>3', '3>4', '4>1']);
    expect(implied.has('1:3')).toBe(false);
    expect(implied.has('2:4')).toBe(false);
  });

  it('ignores a malformed outcome instead of throwing', () => {
    expect(sorted(impliedPairKeys(['1:2', 'x>y', '3>3', '1>2']))).toEqual(['1:2']);
  });
});

describe('decidedPairKeys', () => {
  it('keeps every directly voted pair, including those inside a contradiction', () => {
    const decided = decidedPairKeys(['1:2', '2:3', '1:3'], ['1>2', '2>3', '3>1']);
    expect(sorted(decided)).toEqual(['1:2', '1:3', '2:3']);
  });

  // Deliberate cost cap: the closure runs on every serve and feed read. Raising or removing it
  // needs the closure cached per judge first.
  it('skips nothing past MAX_CLOSURE_VOTES votes, so a heavy judge costs what it did before', () => {
    const chain = Array.from({ length: MAX_CLOSURE_VOTES + 1 }, (_, i) => `${i + 1}>${i + 2}`);
    const voted = chain.map((_, i) => `${i + 1}:${i + 2}`);
    expect(decidedPairKeys(voted, chain)).toEqual(voted);
    expect(decidedPairKeys(voted.slice(0, 2), chain.slice(0, 2))).toContain('1:3');
  });

  it('is the voted pairs alone when no outcomes are stored (votes cast before the skip)', () => {
    expect(decidedPairKeys(['1:2', '2:3'], [])).toEqual(['1:2', '2:3']);
  });
});
