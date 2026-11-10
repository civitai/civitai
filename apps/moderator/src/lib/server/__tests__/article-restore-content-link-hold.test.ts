import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));

const { withContentLinkHold } = await import('../article-moderation');

const none = { deferred: [], refused: [] };

describe('restoring an article that holds content urls', () => {
  it('stays blocked while a url is refused, whatever else it derives to', () => {
    for (const derived of ['Scanned', 'Pending', 'Error', 'Blocked'] as const)
      expect(withContentLinkHold(derived, { deferred: [], refused: ['k'] })).toBe('Blocked');
  });

  it('is not made public by a moderator rating while a url is deferred', () => {
    expect(withContentLinkHold('Scanned', { deferred: ['k'], refused: [] })).toBe('Pending');
    expect(withContentLinkHold('Error', { deferred: ['k'], refused: [] })).toBe('Error');
  });

  it('derives as before with no hold', () => {
    for (const derived of ['Scanned', 'Pending', 'Error', 'Blocked'] as const) {
      expect(withContentLinkHold(derived, undefined)).toBe(derived);
      expect(withContentLinkHold(derived, none)).toBe(derived);
    }
  });
});
