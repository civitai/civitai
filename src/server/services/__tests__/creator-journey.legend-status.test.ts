import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { legendStatusLabel } from '~/components/CreatorJourney/legend-status';
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

describe('getLegendStatus', () => {
  beforeEach(() => withPrivacy(null));

  it('is null for a user who is not a Legend', async () => {
    dbMock.dbRead.userCreatorMilestone.findUnique.mockResolvedValue(null);
    expect(await getLegendStatus(7)).toBeNull();
    expect(dbMock.dbRead.userCreatorMilestone.findUnique).toHaveBeenCalledWith({
      where: { userId_milestoneKey: { userId: 7, milestoneKey: 'score:legend' } },
      select: { achievedAt: true, seenAt: true, milestone: { select: { cosmeticId: true } } },
    });
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
    expect(await getLegendStatus(7)).toEqual({ founding: true, since: null });
  });

  it('dates a Legend whose crossing was observed', async () => {
    dbMock.dbRead.userCreatorMilestone.findUnique.mockResolvedValue(legendRow(null) as never);
    expect(await getLegendStatus(7)).toEqual({ founding: false, since: GRANTED });
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
    expect(await getLegendStatus(7)).toEqual({ founding: false, since: GRANTED });
  });
});

describe('legendStatusLabel', () => {
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
