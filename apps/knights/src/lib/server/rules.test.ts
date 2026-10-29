import { describe, expect, it } from 'vitest';
import { DAILY } from './daily/config';
import { RANK_LADDER } from './progression/config';
import { rulesFacts } from './rules';
import { SMITES } from './smites/config';
import { TRIALS } from './trials/config';

describe('rulesFacts', () => {
  it('quotes the numbers the game runs on', () => {
    const facts = rulesFacts();
    expect(facts.trials.length).toBe(TRIALS.runLength);
    expect(facts.trials.passPercent).toBe(TRIALS.passMark * 100);
    expect(facts.watch.size).toBe(DAILY.watchSize);
    expect(facts.ranks.map((r) => r.rank)).toEqual(RANK_LADDER.map((r) => r.rank));
  });

  it('quotes the hearts from the smite limit', () => {
    expect(rulesFacts().hearts).toBe(SMITES.max);
  });

  it('keeps a vote worth its immediate and graded XP together', () => {
    const { xp } = rulesFacts();
    expect(xp.atVote + xp.onCorrect).toBe(100);
  });

  it('guides all six rating levels, Blocked last', () => {
    const labels = rulesFacts().ratingGuide.map((g) => g.label);
    expect(labels).toEqual(['PG', 'PG-13', 'R', 'X', 'XXX', 'Blocked']);
    expect(rulesFacts().ratingGuide.every((g) => g.description.length > 0)).toBe(true);
  });
});
