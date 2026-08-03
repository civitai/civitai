import { describe, expect, test } from 'vitest';
import { parseParticipationQuery } from '~/components/Challenge/Infinite/ChallengeFiltersDropdown';

// Asserts against wire-format literals rather than `ChallengeParticipation.*`. Comparing the
// parser's output to the same const the parser reads makes both sides collapse together when a
// key is removed, so the test passes on a regression it exists to catch.
describe('parseParticipationQuery', () => {
  test('accepts created', () => {
    expect(parseParticipationQuery('created')).toBe('created');
  });

  test('accepts the pre-existing values', () => {
    expect(parseParticipationQuery('entered')).toBe('entered');
    expect(parseParticipationQuery('not_entered')).toBe('not_entered');
    expect(parseParticipationQuery('won')).toBe('won');
  });

  test('rejects anything else', () => {
    expect(parseParticipationQuery('bogus')).toBeUndefined();
    expect(parseParticipationQuery(undefined)).toBeUndefined();
  });

  test('takes the first value of an array', () => {
    expect(parseParticipationQuery(['created', 'won'])).toBe('created');
  });
});
