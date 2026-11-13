import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReportService from '~/server/services/report.service';

const { bulkSetReportStatus } = vi.hoisted(() => ({
  bulkSetReportStatus: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  bulkSetReportStatus,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

const { default: handler } = await import('~/pages/api/mod/action-report');

const post = (body: Record<string, unknown>) => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  return handler({ method: 'POST', body } as NextApiRequest, res as unknown as NextApiResponse);
};

beforeEach(() => vi.clearAllMocks());

describe('/api/mod/action-report', () => {
  it('actions the report it names', async () => {
    await post({ reportId: '2', status: 'Actioned', userId: '9' });

    expect(bulkSetReportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [2], status: 'Actioned', userId: 9 })
    );
  });

  it.each([
    { reportId: '1.5', userId: '9' },
    { reportId: '2', userId: '9.5' },
  ])('refuses an id that is not a whole number: %o', async (ids) => {
    await expect(post({ ...ids, status: 'Actioned' })).rejects.toThrow();
    expect(bulkSetReportStatus).not.toHaveBeenCalled();
  });
});
