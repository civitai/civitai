import { describe, expect, it, vi } from 'vitest';
import { DomainColor } from '~/shared/utils/prisma/enums';

// leaderboard.service reaches the db/router graph at import; this test only needs the
// pure filter, so stub the heavy edges rather than widening them.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
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
