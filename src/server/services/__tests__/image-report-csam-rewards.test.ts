import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ReportService from '~/server/services/report.service';

/** Flagging images as CSAM actions their reports without rewarding an owner. Ids are invented. */

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const { bulkSetReportStatus } = vi.hoisted(() => ({
  bulkSetReportStatus: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  bulkSetReportStatus,
}));

const { reportCsamImages } = await import('~/server/services/image.service');

const OWNER = 20;
const OTHER_OWNER = 21;

beforeEach(() => {
  bulkSetReportStatus.mockClear();
  dbMock.dbRead.image.findMany.mockResolvedValue([
    { userId: OWNER, reports: [{ reportId: 7 }, { reportId: 8 }] },
    { userId: OTHER_OWNER, reports: [{ reportId: 9 }] },
  ] as never);
});

describe('reportCsamImages', () => {
  it('actions the images’ reports, rewarding no owner in the batch for any of them', async () => {
    await reportCsamImages({ imageIds: [500, 501], user: { id: 2, isModerator: true } as never });

    expect(bulkSetReportStatus).toHaveBeenCalledTimes(1);
    const { ids, noRewardFor, rewardRemovedReporters } = bulkSetReportStatus.mock.calls[0][0] as {
      ids: number[];
      noRewardFor: (reportId: number) => number[];
      rewardRemovedReporters: boolean;
    };
    expect(ids).toEqual([7, 8, 9]);
    expect(rewardRemovedReporters).toBe(false);
    for (const reportId of [7, 9])
      expect(new Set(noRewardFor(reportId))).toEqual(new Set([OWNER, OTHER_OWNER]));
  });
});
