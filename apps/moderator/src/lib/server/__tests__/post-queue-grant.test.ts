import { describe, expect, it, vi } from 'vitest';

/**
 * The main app's `postText.moderate` holds a moderator to the `/reports` page row
 * (`hasModeratorPageAccess`), because that row is what grants the post queue here: `/reports` is a
 * shared section, so a row for `/reports/post` itself grants nothing.
 */
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
const { applyGrants, canAccess } = await import('$lib/server/access');

const MOD = { id: 7, roles: ['moderator:reports'] };

describe('the post report queue grant', () => {
  it('follows the /reports row', () => {
    applyGrants({ '/reports': ['moderator:reports'] });
    expect(canAccess(MOD, '/reports/post')).toBe(true);
    applyGrants({});
    expect(canAccess(MOD, '/reports/post')).toBe(false);
  });

  it('is not opened by a row for /reports/post alone', () => {
    applyGrants({ '/reports/post': ['moderator:reports'] });
    expect(canAccess(MOD, '/reports/post')).toBe(false);
  });
});
