import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { legendStatusLabel } from '~/components/CreatorJourney/legend-status';
import { getLegendStatus } from '~/server/services/creator-journey.service';
import { creatorMilestoneRegistry } from '~/server/services/creator-milestone-registry';

const { launchedAt } = creatorMilestoneRegistry['score:legend'];

describe('getLegendStatus', () => {
  it('is null for a user who is not a Legend', async () => {
    dbMock.dbRead.userCreatorMilestone.findUnique.mockResolvedValue(null);
    expect(await getLegendStatus(7)).toBeNull();
    expect(dbMock.dbRead.userCreatorMilestone.findUnique).toHaveBeenCalledWith({
      where: { userId_milestoneKey: { userId: 7, milestoneKey: 'score:legend' } },
      select: { achievedAt: true },
    });
  });

  // Justin's call (2026-10-06): Legends granted at launch have no known crossing date, so they are
  // "Founding Legend". Showing their launch-night grant date as "Legend since" would be false.
  it('calls a Legend granted before the tier launched a founding Legend, with no date', async () => {
    dbMock.dbRead.userCreatorMilestone.findUnique.mockResolvedValue({
      achievedAt: new Date(launchedAt.getTime() - 1),
    } as never);
    expect(await getLegendStatus(7)).toEqual({ founding: true, since: null });
  });

  it('dates a Legend who crossed after launch', async () => {
    const achievedAt = new Date('2027-03-01T00:30:00Z');
    dbMock.dbRead.userCreatorMilestone.findUnique.mockResolvedValue({ achievedAt } as never);
    expect(await getLegendStatus(7)).toEqual({ founding: false, since: achievedAt });
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
