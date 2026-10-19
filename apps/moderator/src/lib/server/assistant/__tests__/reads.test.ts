import { describe, expect, it, vi } from 'vitest';

/**
 * The account search refuses the shapes that would read the whole `User` table, and builds its
 * prefix bound so the username index (citext, case-insensitive) is what answers.
 */

vi.mock('$lib/server/db', () => ({ dbRead: {} }));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => ({}) }));

const { prefixUpperBound, searchRefusal, CONTAINS_WINDOW_DAYS } = await import('../reads');

const day = 86_400_000;
const recent = (days: number) => new Date(Date.now() - days * day);

describe('searchRefusal', () => {
  it('refuses a fragment search over every account', () => {
    expect(searchRefusal({ usernameContains: 'bot', banned: 'any', limit: 50 })).toMatch(
      /banned: "only"/
    );
  });

  it('allows a fragment search over banned accounts, or over a short signup window', () => {
    expect(searchRefusal({ usernameContains: 'bot', banned: 'only', limit: 50 })).toBeNull();
    expect(
      searchRefusal({
        usernameContains: 'bot',
        banned: 'any',
        createdAfter: recent(CONTAINS_WINDOW_DAYS - 1),
        limit: 50,
      })
    ).toBeNull();
    expect(
      searchRefusal({
        usernameContains: 'bot',
        banned: 'any',
        createdAfter: recent(CONTAINS_WINDOW_DAYS + 5),
        limit: 50,
      })
    ).not.toBeNull();
  });

  it('allows a prefix search on its own, and refuses a search with no criteria', () => {
    expect(searchRefusal({ usernamePrefix: 'mossbank', banned: 'any', limit: 50 })).toBeNull();
    expect(searchRefusal({ banned: 'only', limit: 50 })).not.toBeNull();
  });
});

describe('prefix bound', () => {
  it('is the lowercased prefix with its last character advanced', () => {
    expect(prefixUpperBound('MossBank')).toBe('mossbanl');
    expect('mossbank42' >= 'mossbank' && 'mossbank42' < prefixUpperBound('mossbank')).toBe(true);
    expect('mossbanl' < prefixUpperBound('mossbank')).toBe(false);
  });
});
