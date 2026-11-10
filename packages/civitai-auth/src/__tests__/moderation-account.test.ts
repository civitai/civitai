import { describe, expect, it } from 'vitest';
import { isModerationAccountUser } from '../moderation-account';

describe('isModerationAccountUser', () => {
  it('matches the configured id, as a number or an env string', () => {
    expect(isModerationAccountUser({ id: 900 }, '900')).toBe(true);
    expect(isModerationAccountUser({ id: '900' }, 900)).toBe(true);
    expect(isModerationAccountUser({ id: 901, username: 'someone' }, '900')).toBe(false);
  });

  it('still matches by username when the id is missing or malformed', () => {
    for (const configured of [undefined, '', 'abc', '-3'])
      expect(isModerationAccountUser({ id: 900, username: 'civitaimoderation' }, configured)).toBe(
        true
      );
    expect(isModerationAccountUser({ id: 900, username: 'someone' }, undefined)).toBe(false);
  });
});
