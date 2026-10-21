import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Rewards from '~/server/rewards';
import type * as ModeratorService from '~/server/services/moderator.service';

/** Who is rewarded when reports are actioned. Ids are invented. */

const { apply } = vi.hoisted(() => ({ apply: vi.fn(async () => undefined) }));
vi.mock('~/server/rewards', async (importOriginal) => ({
  ...(await importOriginal<typeof Rewards>()),
  reportAcceptedReward: { apply },
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: vi.fn(async () => undefined),
}));

const { bulkSetReportStatus } = await import('~/server/services/report.service');

const REPORTER = 30;
const ALSO = 31;
const BANNED = 32;
const UPLOADER = 33;

beforeEach(() => {
  apply.mockClear();
  dbMock.dbWrite.report.update.mockReset().mockResolvedValue({} as never);
  dbMock.dbRead.report.findMany.mockResolvedValue([
    { id: 7, userId: REPORTER, alsoReportedBy: [ALSO, BANNED] },
    { id: 8, userId: UPLOADER, alsoReportedBy: [] },
  ] as never);
  dbMock.dbRead.user.findMany
    .mockReset()
    .mockImplementation((async ({ where }: { where: { id: { in: number[] } } }) =>
      where.id.in.filter((id) => id === BANNED).map((id) => ({ id }))) as never);
});

const rewarded = () =>
  apply.mock.calls.map(([event]) => (event as { userId: number; reportId: number }).userId);

describe('bulkSetReportStatus', () => {
  it('actions every report but rewards no excluded or removed reporter', async () => {
    await bulkSetReportStatus({
      ids: [7, 8],
      status: 'Actioned',
      userId: 2,
      noRewardFor: [UPLOADER],
      rewardRemovedReporters: false,
    });

    expect(dbMock.dbWrite.report.update.mock.calls.map(([args]) => args.where.id)).toEqual([7, 8]);
    expect(rewarded().sort()).toEqual([REPORTER, ALSO]);
  });

  it('still rewards every reporter by default', async () => {
    await bulkSetReportStatus({ ids: [7, 8], status: 'Actioned', userId: 2 });

    expect(rewarded().sort()).toEqual([REPORTER, ALSO, BANNED, UPLOADER]);
    expect(dbMock.dbRead.user.findMany).not.toHaveBeenCalled();
  });
});
