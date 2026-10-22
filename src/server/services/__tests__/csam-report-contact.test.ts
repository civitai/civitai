import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CybertiplineTools from '@civitai/cybertipline-tools';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Wire contract: NCMEC passes this address to the agencies that follow up on a report.
const CONTACT_EMAIL = 'compliance@civitai.com';

const { submitReport } = vi.hoisted(() => ({ submitReport: vi.fn() }));

vi.mock('@civitai/cybertipline-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof CybertiplineTools>()),
  Client: class {
    getStatus = async () => ({ data: { responseCode: 0 } });
    submitReport = submitReport;
    uploadFile = vi.fn();
    submitFileDetails = vi.fn();
    finishReport = vi.fn();
    cancelReport = vi.fn();
  },
}));

vi.mock('~/utils/file-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchBlobAsFile: async () => new File(['generated'], 'generated.png'),
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: undefined,
}));

import type { CsamReportProps } from '~/server/services/csam.service-new';
import { processCsamReport } from '~/server/services/csam.service-new';

function makeReport(overrides: Partial<CsamReportProps>) {
  return {
    id: 1,
    userId: 20,
    reportedById: 10,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    images: [],
    details: {},
    ...overrides,
  } as unknown as CsamReportProps;
}

describe('CyberTipline report contact person', () => {
  beforeEach(() => {
    submitReport.mockReset().mockResolvedValue({ data: { reportId: 99 } });
    dbMock.dbRead.user.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
      where.id === 10
        ? { id: 10, email: 'mod@example.invalid', name: 'Mod', isModerator: true }
        : { id: 20, email: 'user@example.invalid', name: 'User', username: 'user' }
    );
  });

  it.each([
    [
      'in-app report',
      makeReport({
        type: 'GeneratedImage',
        details: { generatedImages: [{ jobId: 'job-1', blobs: [{ url: 'blob-1' }] }] },
      }),
    ],
    [
      'external-link report',
      makeReport({ type: 'ExternalLink', details: { email: 'x@example.invalid' } }),
    ],
  ])('names the compliance address on a submitted %s', async (_, report) => {
    dbMock.dbWrite.csamReport.updateMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.csamReport.findFirst.mockResolvedValue(report);
    await processCsamReport(report);

    expect(submitReport).toHaveBeenCalledTimes(1);
    expect(submitReport.mock.calls[0][0].reporter.contactPerson).toEqual({
      email: [{ email: CONTACT_EMAIL }],
    });
  });
});
