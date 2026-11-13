import { describe, expect, it } from 'vitest';

import { promptDerivationHolds } from '~/utils/prompt-similarity';

const ORDINARY_WORD = 'zebra';
const SOURCE = 'a girl standing in a field, sunset, WORD, detailed';
const ITERATED = `${SOURCE}, masterpiece`;

function scoreWith(word: string, source: string, current: string) {
  return promptDerivationHolds(source.replace('WORD', word), current.replace('WORD', word));
}

// cleanText lowercases and strips to [a-z0-9], so most of these never reach the
// term maps today; they bite if it ever keeps case or underscores. Do not trim
// the list to the names that currently fail on a plain-object map.
describe('a prompt word that names an Object.prototype member scores like any other word', () => {
  const baseline = scoreWith(ORDINARY_WORD, SOURCE, ITERATED);

  it('has a baseline that actually clears the gate', () => {
    expect(baseline.holds).toBe(true);
    expect(baseline.score).toBeGreaterThan(0);
  });

  it.each(Object.getOwnPropertyNames(Object.prototype))('%s in both prompts', (word) => {
    expect(scoreWith(word, SOURCE, ITERATED)).toEqual(baseline);
  });

  it.each(Object.getOwnPropertyNames(Object.prototype))('%s in the current prompt only', (word) => {
    const ordinary = scoreWith(ORDINARY_WORD, 'a girl standing in a field', SOURCE);
    expect(ordinary.score).toBeGreaterThan(0);
    expect(scoreWith(word, 'a girl standing in a field', SOURCE)).toEqual(ordinary);
  });
});
