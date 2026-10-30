import { describe, expect, it, vi } from 'vitest';
import { DomainColor } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/routers/base.router', () => ({ isModerator: false }));
vi.mock('~/server/services/user.service', () => ({
  getCosmeticsForUsers: vi.fn(),
  getProfilePicturesForUsers: vi.fn(),
}));

/** Does a board with `boardDomains` show under `filter`? Mirrors Prisma `hasSome`. */
const visible = (boardDomains: DomainColor[], filter: { hasSome: DomainColor[] }) =>
  boardDomains.some((d) => filter.hasSome.includes(d));

describe('domainVisibilityFilter', () => {
  it('shows SFW boards but NOT mature ones when the domain is unresolved', async () => {
    const { domainVisibilityFilter } = await import('../leaderboard.service');
    const filter = domainVisibilityFilter(undefined);

    // The regression this pins: PR previews ship only NEXT_PUBLIC_SERVER_DOMAIN_*,
    // so every request resolves undefined. An `all`-only filter blanked the boards.
    expect(visible([DomainColor.green, DomainColor.blue], filter)).toBe(true);
    expect(visible([DomainColor.all], filter)).toBe(true);
    // Failing closed still has to hold for mature.
    expect(visible([DomainColor.red], filter)).toBe(false);
  });

  it('shows a colors own boards plus all, and hides other colors', async () => {
    const { domainVisibilityFilter } = await import('../leaderboard.service');

    const green = domainVisibilityFilter(DomainColor.green);
    expect(visible([DomainColor.green, DomainColor.blue], green)).toBe(true);
    expect(visible([DomainColor.all], green)).toBe(true);
    expect(visible([DomainColor.red], green)).toBe(false);

    const red = domainVisibilityFilter(DomainColor.red);
    expect(visible([DomainColor.red], red)).toBe(true);
    expect(visible([DomainColor.all], red)).toBe(true);
    // Red resolves to red ALONE so the SFW variant of a split board doesn't
    // render alongside its mature counterpart.
    expect(visible([DomainColor.green, DomainColor.blue], red)).toBe(false);
  });

  it('never surfaces a red-exclusive board on any non-red resolution', async () => {
    const { domainVisibilityFilter } = await import('../leaderboard.service');
    for (const domain of [undefined, DomainColor.green, DomainColor.blue]) {
      expect(visible([DomainColor.red], domainVisibilityFilter(domain))).toBe(false);
    }
  });
});

// The cases above exercise the pure function. These pin that `getLeaderboards` actually
// CALLS it — the wiring, which nothing else covered. That matters more than it looks:
// UserProfileEditModal's showcase picker deliberately carries no domain filter of its
// own and relies entirely on this query being scoped, so if the `domain` key stops
// reaching the `where`, .com starts listing mature boards in the picker and no other
// test notices.
describe('getLeaderboards applies the filter to the query', () => {
  const whereOfLastCall = () => {
    const calls = dbMock.dbRead.leaderboard.findMany.mock.calls;
    if (!calls.length) throw new Error('getLeaderboards issued no findMany');
    return (calls.at(-1)?.[0] as { where: Record<string, unknown> }).where;
  };

  it.each([
    ['red host', DomainColor.red],
    ['green host', DomainColor.green],
    ['unresolved host', undefined],
  ])('scopes the board list on a %s', async (_label, domain) => {
    const { getLeaderboards, domainVisibilityFilter } = await import('../leaderboard.service');
    dbMock.dbRead.leaderboard.findMany.mockResolvedValue([]);

    await getLeaderboards({ domain, isModerator: false });

    // Compared against the helper's own output rather than a literal, so the two
    // cannot drift apart silently.
    expect(whereOfLastCall().domain).toEqual(domainVisibilityFilter(domain));
  });

  it('still restricts non-moderators to public, active boards', async () => {
    const { getLeaderboards } = await import('../leaderboard.service');
    dbMock.dbRead.leaderboard.findMany.mockResolvedValue([]);

    await getLeaderboards({ domain: DomainColor.red, isModerator: false });

    const where = whereOfLastCall();
    expect(where.public).toBe(true);
    expect(where.active).toBe(true);
  });
});
