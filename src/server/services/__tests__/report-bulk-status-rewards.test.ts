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

const { bulkSetReportStatus, csamReportRewardExclusions } = await import(
  '~/server/services/report.service'
);

const REPORTER = 30;
const ALSO = 31;
const BANNED = 32;
const DELETED = 33;
const UPLOADER = 34;

type User = { id: number; bannedAt: Date | null; deletedAt: Date | null };
const users: User[] = [
  { id: REPORTER, bannedAt: null, deletedAt: null },
  { id: ALSO, bannedAt: null, deletedAt: null },
  { id: BANNED, bannedAt: new Date(), deletedAt: null },
  { id: DELETED, bannedAt: null, deletedAt: new Date() },
  { id: UPLOADER, bannedAt: null, deletedAt: null },
];

type Where = {
  id: { in: number[] };
  OR: { bannedAt?: { not: null }; deletedAt?: { not: null } }[];
};
// Evaluates the removed-reporter filter itself, so a changed filter changes who is rewarded.
const removedUsers = async ({ where }: { where: Where }) =>
  users
    .filter((user) => where.id.in.includes(user.id))
    .filter((user) =>
      where.OR.some(
        (clause) =>
          (clause.bannedAt && user.bannedAt !== null) ||
          (clause.deletedAt && user.deletedAt !== null)
      )
    )
    .map(({ id }) => ({ id }));

beforeEach(() => {
  apply.mockClear();
  // The rows the guarded UPDATE changed and returned.
  dbMock.dbWrite.$queryRaw.mockReset().mockResolvedValue([
    { id: 7, userId: REPORTER, alsoReportedBy: [ALSO, BANNED, DELETED, UPLOADER] },
    { id: 8, userId: UPLOADER, alsoReportedBy: [] },
  ] as never);
  dbMock.dbWrite.user.findMany.mockReset().mockImplementation(removedUsers as never);
});

const rewarded = () =>
  apply.mock.calls
    .map(([event]) => {
      const { userId, reportId } = event as { userId: number; reportId: number };
      return `${reportId}:${userId}`;
    })
    .sort();

describe('bulkSetReportStatus', () => {
  it('actions every report but rewards no excluded or removed reporter of it', async () => {
    await bulkSetReportStatus({
      ids: [7, 8],
      status: 'Actioned',
      userId: 2,
      noRewardFor: (reportId) => (reportId === 8 ? [UPLOADER] : [ALSO]),
      rewardRemovedReporters: false,
    });

    expect(dbMock.dbWrite.$queryRaw.mock.calls[0].slice(1)).toContainEqual([7, 8]);
    expect(rewarded()).toEqual([`7:${REPORTER}`, `7:${UPLOADER}`].sort());
  });

  it('still rewards every reporter by default', async () => {
    await bulkSetReportStatus({ ids: [7, 8], status: 'Actioned', userId: 2 });

    expect(rewarded()).toEqual(
      [REPORTER, ALSO, BANNED, DELETED, UPLOADER]
        .map((id) => `7:${id}`)
        .concat(`8:${UPLOADER}`)
        .sort()
    );
  });
});

describe('csamReportRewardExclusions', () => {
  it('excludes the reported account from every report and an owner from reports on their image', () => {
    const exclude = csamReportRewardExclusions(UPLOADER, [
      { reportId: 7, image: { userId: REPORTER } },
      { reportId: 8, image: { userId: ALSO } },
    ]);

    expect(exclude(7)).toEqual([UPLOADER, REPORTER]);
    expect(exclude(8)).toEqual([UPLOADER, ALSO]);
    expect(exclude(9)).toEqual([UPLOADER]);
  });
});
