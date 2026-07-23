import { describe, expect, test } from 'vitest';
import { parseParticipationQuery } from '~/components/Challenge/Infinite/ChallengeFiltersDropdown';
import { ChallengeParticipation } from '~/server/schema/challenge.schema';

describe('parseParticipationQuery', () => {
  test('accepts created', () => {
    expect(parseParticipationQuery('created')).toBe(ChallengeParticipation.Created);
  });

  test('accepts the pre-existing values', () => {
    expect(parseParticipationQuery('entered')).toBe(ChallengeParticipation.Entered);
    expect(parseParticipationQuery('not_entered')).toBe(ChallengeParticipation.NotEntered);
    expect(parseParticipationQuery('won')).toBe(ChallengeParticipation.Won);
  });

  test('rejects anything else', () => {
    expect(parseParticipationQuery('bogus')).toBeUndefined();
    expect(parseParticipationQuery(undefined)).toBeUndefined();
  });

  test('takes the first value of an array', () => {
    expect(parseParticipationQuery(['created', 'won'])).toBe(ChallengeParticipation.Created);
  });
});
