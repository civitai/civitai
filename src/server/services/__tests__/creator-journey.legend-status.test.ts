import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ showcaseRows: vi.fn() }));
vi.mock('~/server/services/creator-showcase.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorShowcase>()),
  getVisibleShowcaseRows: mocks.showcaseRows,
}));

import type * as CreatorShowcase from '~/server/services/creator-showcase.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { legendStatusLabel, showcaseMonthLabel } from '~/components/CreatorJourney/legend-status';
import { getLegendStatus } from '~/server/services/creator-journey.service';

const GRANTED = new Date('2026-10-20T03:00:00Z');
const LEGEND_BADGE = 2869;

const legendRow = (seenAt: Date | null) => ({
  achievedAt: new Date(GRANTED),
  seenAt,
  milestone: { cosmeticId: LEGEND_BADGE },
});

const withPrivacy = (privacySettings: Record<string, unknown> | null) =>
  dbMock.dbRead.userProfile.findUnique.mockResolvedValue(
    (privacySettings ? { privacySettings } : null) as never
  );

const hallOfFame = (...userIds: number[]) =>
  mocks.showcaseRows.mockResolvedValue({
    newSupernovas: [],
    legends: userIds.map((userId) => ({ userId })),
  });

describe('getLegendStatus', () => {
  beforeEach(() => {
    withPrivacy(null);
    hallOfFame();
  });

  it('is null for a user who is not a Legend', async () => {
    dbMock.dbRead.userCreatorMilestone.findUnique.mockResolvedValue(null);
    expect(await getLegendStatus(7)).toBeNull();
    expect(dbMock.dbRead.userCreatorMilestone.findUnique).toHaveBeenCalledWith({
      where: { userId_milestoneKey: { userId: 7, milestoneKey: 'score:legend' } },
      select: { achievedAt: true, seenAt: true, milestone: { select: { cosmeticId: true } } },
    });
    expect(dbMock.dbRead.userProfile.findUnique).not.toHaveBeenCalled();
  });

  // Justin's call (2026-10-06): a Legend whose crossing nobody observed, such as everyone the launch
  // backfill granted, is a "Founding Legend". Their achievedAt is the night the grant ran, so showing
  // it as "Legend since" would be false. The backfill runs after the tier's launchedAt, so that date
  // cannot tell them apart.
  it('calls a silently granted Legend a founding Legend, with no date, whenever it was granted', async () => {
    // Distinct Date objects with equal times, as Prisma returns them.
    dbMock.dbRead.userCreatorMilestone.findUnique.mockResolvedValue(
      legendRow(new Date(GRANTED)) as never
    );
    expect(await getLegendStatus(7)).toEqual({ founding: true, since: null, oneOf: null });
  });

  it('dates a Legend whose crossing was observed', async () => {
    dbMock.dbRead.userCreatorMilestone.findUnique.mockResolvedValue(legendRow(null) as never);
    expect(await getLegendStatus(7)).toEqual({ founding: false, since: GRANTED, oneOf: null });
  });

  it.each([
    ['hides the Legend badge', { hiddenBadgeIds: [LEGEND_BADGE] }],
    ['hides all badges', { showBadges: false }],
  ])('says nothing when the owner %s', async (_, privacySettings) => {
    dbMock.dbRead.userCreatorMilestone.findUnique.mockResolvedValue(legendRow(null) as never);
    withPrivacy(privacySettings);
    expect(await getLegendStatus(7)).toBeNull();
  });

  it('still shows when the owner hides some other badge', async () => {
    dbMock.dbRead.userCreatorMilestone.findUnique.mockResolvedValue(legendRow(null) as never);
    withPrivacy({ hiddenBadgeIds: [LEGEND_BADGE + 1], showBadges: true });
    expect(await getLegendStatus(7)).toEqual({ founding: false, since: GRANTED, oneOf: null });
  });
});

describe('one of N', () => {
  beforeEach(() => {
    mocks.showcaseRows.mockReset();
    hallOfFame();
    withPrivacy(null);
    dbMock.dbRead.userCreatorMilestone.findUnique.mockResolvedValue(legendRow(null) as never);
  });

  it('counts the Hall of Fame for a Legend it lists', async () => {
    hallOfFame(3, 7, 9);
    expect(await getLegendStatus(7)).toMatchObject({ oneOf: 3 });
  });

  // Agreed with the CJ lead (2026-10-07): a Legend the Hall of Fame leaves out (muted, struck,
  // suppressed, leaderboard-excluded) keeps the label, but "one of 3" would claim a place they lack.
  it('gives no count to a Legend the Hall of Fame leaves out', async () => {
    hallOfFame(3, 9);
    expect(await getLegendStatus(7)).toEqual({ founding: false, since: GRANTED, oneOf: null });
  });

  it('keeps the label when the showcase cannot be read', async () => {
    mocks.showcaseRows.mockRejectedValue(new Error('clickhouse down'));
    expect(await getLegendStatus(7)).toEqual({ founding: false, since: GRANTED, oneOf: null });
  });

  it('does not read the showcase for a profile without a shown Legend badge', async () => {
    withPrivacy({ showBadges: false });
    expect(await getLegendStatus(7)).toBeNull();
    dbMock.dbRead.userCreatorMilestone.findUnique.mockResolvedValue(null);
    expect(await getLegendStatus(8)).toBeNull();
    expect(mocks.showcaseRows).not.toHaveBeenCalled();
  });
});

describe('legendStatusLabel', () => {
  it('appends the count, grouped', () => {
    expect(legendStatusLabel({ founding: true, since: null, oneOf: 1708 })).toBe(
      'Founding Legend · one of 1,708'
    );
  });

  it('appends the count to a dated Legend', () => {
    expect(
      legendStatusLabel({ founding: false, since: new Date('2027-03-15T12:00:00Z'), oneOf: 2 })
    ).toBe('Legend since March 2027 · one of 2');
  });

  it('has no count suffix without a count', () => {
    expect(legendStatusLabel({ founding: true, since: null, oneOf: null })).toBe('Founding Legend');
  });

  it('reads Founding Legend for a founding Legend', () => {
    expect(legendStatusLabel({ founding: true, since: null })).toBe('Founding Legend');
  });

  // Pinned to a zone behind UTC: under the UTC that CI runs in, a local-time format reads the same.
  it('names the UTC month of a later crossing', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      expect(legendStatusLabel({ founding: false, since: new Date('2027-03-01T00:30:00Z') })).toBe(
        'Legend since March 2027'
      );
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe('showcaseMonthLabel', () => {
  // Same zone pin as above. The list is the UTC month's, so a viewer behind UTC must not see last month's name.
  it('names the UTC month, not the viewer local one', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      expect(showcaseMonthLabel(new Date('2026-11-01T03:00:00Z'))).toBe('November');
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});
