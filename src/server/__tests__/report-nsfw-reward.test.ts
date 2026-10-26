import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Rewards from '~/server/rewards';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as TagService from '~/server/services/tag.service';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

/** Who is paid when an NSFW report is actioned, from the details its filing wrote. Ids are invented. */

const { apply, reportCreate } = vi.hoisted(() => ({
  apply: vi.fn(async () => undefined),
  reportCreate: vi.fn(),
}));

dbMock.dbWrite.$transaction.mockImplementation(async (arg: unknown) =>
  typeof arg === 'function'
    ? arg({
        report: { create: (...args: unknown[]) => reportCreate(...args) },
        image: { update: vi.fn(), findUnique: vi.fn(async () => null) },
        model: { update: vi.fn() },
      })
    : Promise.all(arg as Promise<unknown>[])
);

vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));
vi.mock('~/server/services/tag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TagService>()),
  addTagVotes: vi.fn(async () => undefined),
}));
vi.mock('~/server/rewards', async (importOriginal) => ({
  ...(await importOriginal<typeof Rewards>()),
  reportAcceptedReward: { apply },
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: vi.fn(async () => undefined),
}));

const { createReportHandler } = await import('~/server/controllers/report.controller');
const { bulkSetReportStatus } = await import('~/server/services/report.service');

const verified = (id: number) => ({
  id,
  isModerator: false,
  emailVerified: new Date('2024-01-01'),
});
const newSignup = (id: number) => ({
  ...verified(id),
  emailVerified: null,
  meta: { emailVerificationRequired: true },
});

const file = (user: unknown, details: Record<string, unknown>) =>
  createReportHandler({
    input: { type: ReportEntity.Image, id: 63, reason: ReportReason.NSFW, details },
    ctx: { user, track: { report: vi.fn() } } as never,
  });

type StoredReport = {
  id: number;
  userId: number;
  status: ReportStatus;
  alsoReportedBy: number[];
  details: unknown;
  previouslyReviewedCount: number;
};

/** Files a report and returns the row the database would now hold. */
async function fileNew(user: { id: number }, details: Record<string, unknown>) {
  reportCreate.mockClear();
  await file(user, details);
  const { data } = reportCreate.mock.calls[0][0];
  return {
    id: 74,
    userId: user.id,
    status: data.status,
    alsoReportedBy: [],
    details: data.details,
    previouslyReviewedCount: 0,
  } as StoredReport;
}

/** Files a report that folds into `row`, and returns the row after the fold. */
async function fileInto(row: StoredReport, user: { id: number }, details: Record<string, unknown>) {
  dbMock.dbWrite.report.findFirst.mockResolvedValueOnce(row);
  dbMock.dbWrite.report.update.mockImplementationOnce(async ({ data }) => ({ ...row, ...data }));
  await file(user, details);
  const { data } = dbMock.dbWrite.report.update.mock.calls.at(-1)![0];
  return { ...row, ...data } as StoredReport;
}

const rewardedFor = async (row: StoredReport) => {
  dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([row] as never);
  await bulkSetReportStatus({ ids: [row.id], status: ReportStatus.Actioned, userId: 2 });
  return apply.mock.calls.map(([event]) => (event as { userId: number }).userId).sort();
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.report.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.report.update.mockResolvedValue({} as never);
});

describe('an actioned NSFW image report pays', () => {
  it('nobody it marks, whatever the client sent, while an unmarked co-reporter is paid', async () => {
    const filed = await fileNew(newSignup(41), { tags: ['partial nudity'], noReportReward: false });
    // A folded-in reporter who sent no details of their own is marked all the same.
    const folded = await fileInto(filed, newSignup(42), {});
    const row = { ...folded, alsoReportedBy: [...folded.alsoReportedBy, 43] };

    expect(await rewardedFor(row)).toEqual([43]);
  });

  it('nobody it marks when the client left the key out', async () => {
    const filed = await fileNew(newSignup(41), { tags: ['partial nudity'] });

    expect(await rewardedFor({ ...filed, status: ReportStatus.Pending })).toEqual([]);
  });

  it('a verified filer and co-reporter as before, even when the client sent the key', async () => {
    const filed = await fileNew(verified(50), { tags: ['partial nudity'], noReportReward: true });

    expect(
      await rewardedFor({ ...filed, status: ReportStatus.Pending, alsoReportedBy: [51] })
    ).toEqual([50, 51]);
  });
});
