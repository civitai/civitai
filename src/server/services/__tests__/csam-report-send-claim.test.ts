import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CybertiplineTools from '@civitai/cybertipline-tools';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The send claims its report, works from the row it re-reads, and marks the report sent only once
 * NCMEC has the finished CyberTip. All ids and bytes below are invented.
 */

// `isProd: true` makes `NEXT_PUBLIC_CIVITAI_LINK` required at module scope; a local `.env` hides
// that, CI does not.
await vi.hoisted(async () => {
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://example.invalid/civitai-link';
});

const { submitReport, uploadFile, finishReport, cancelReport, getObject, fetchBlobAsFile } =
  vi.hoisted(() => ({
    submitReport: vi.fn(),
    uploadFile: vi.fn(),
    finishReport: vi.fn(),
    cancelReport: vi.fn(),
    getObject: vi.fn(),
    fetchBlobAsFile: vi.fn(),
  }));

vi.mock('@civitai/cybertipline-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof CybertiplineTools>()),
  Client: class {
    getStatus = async () => ({ data: { responseCode: 0 } });
    submitReport = submitReport;
    uploadFile = uploadFile;
    submitFileDetails = vi.fn();
    finishReport = finishReport;
    cancelReport = cancelReport;
  },
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: undefined,
}));

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isProd: true,
}));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getImageUploadBackend: async () => ({
    bucket: 'test-images',
    backend: 'backblaze',
    s3: { send: () => getObject() },
  }),
}));

vi.mock('~/utils/file-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchBlobAsFile,
}));

vi.mock('~/server/services/file.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFileForModelVersion: async () => ({ status: 'not-found' }),
}));

import type { CsamReportProps } from '~/server/services/csam.service-new';
import { getCsamsToArchive, processCsamReport } from '~/server/services/csam.service-new';
import { logToAxiom } from '~/server/logging/client';

const stored = Buffer.from('the bytes the user uploaded');

const report = {
  id: 1,
  userId: 20,
  reportedById: 10,
  type: 'Image',
  createdAt: new Date(Date.now() - 3_600_000),
  reportSentAt: null,
  reportId: null,
  images: [{ id: 501 }],
  details: {},
} as unknown as CsamReportProps;

const imageRow = (id: number) => ({
  id,
  url: `stored-key-${id}`,
  name: 'upload.png',
  type: 'image',
  mimeType: 'image/png',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  meta: {},
  post: null,
  tags: [],
});

/** What the claim re-reads from the primary; by default the report as the run found it. */
let primaryRow: CsamReportProps;
const claimWrites = () =>
  dbMock.dbWrite.csamReport.updateMany.mock.calls.map(([args]) => args as Record<string, any>);
const writesWith = (key: string) => claimWrites().filter(({ data }) => key in data);
const stamps = () => writesWith('reportSentAt');
const releases = () => claimWrites().filter(({ data }) => data.sendClaimId === null);
const lines = (subType: string) =>
  vi
    .mocked(logToAxiom)
    .mock.calls.map(([payload]) => payload as Record<string, unknown>)
    .filter((line) => line.subType === subType);
const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];

beforeEach(() => {
  vi.mocked(logToAxiom).mockClear();
  primaryRow = report;
  submitReport.mockReset().mockResolvedValue({ data: { reportId: 99 } });
  uploadFile.mockReset().mockResolvedValue({ data: { fileId: 'file-1', hash: 'ncmec-md5' } });
  finishReport.mockReset().mockResolvedValue({});
  cancelReport.mockReset().mockResolvedValue({});
  fetchBlobAsFile.mockReset().mockResolvedValue(new File(['generated'], 'generated.png'));
  getObject.mockReset().mockImplementation(async () => ({
    Body: { transformToByteArray: async () => new Uint8Array(stored) },
    ContentType: 'image/png',
    ContentLength: stored.length,
  }));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network fetch'));
  dbMock.dbRead.user.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    where.id === 10
      ? { id: 10, email: 'mod@example.invalid', name: 'Mod', isModerator: true }
      : { id: 20, email: 'user@example.invalid', name: 'User', username: 'user' }
  );
  // Only image 501 exists.
  dbMock.dbRead.image.findMany.mockImplementation(
    async ({ where }: { where: { id: { in: number[] } } }) =>
      where.id.in.includes(501) ? [imageRow(501)] : []
  );
  // Only model version 7 exists.
  dbMock.dbRead.modelVersion.findMany.mockImplementation(
    async ({ where }: { where: { id: { in: number[] } } }) =>
      where.id.in.includes(7)
        ? [{ id: 7, createdAt: new Date(), name: 'v1', model: { id: 70, name: 'm' } }]
        : []
  );
  dbMock.dbWrite.csamReport.updateMany.mockReset().mockResolvedValue({ count: 1 });
  dbMock.dbWrite.csamReport.findFirst.mockReset().mockImplementation(async () => primaryRow);
  dbMock.dbWrite.csamReport.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  dbMock.dbWrite.$executeRaw.mockReset().mockResolvedValue(1);
});

describe('marking a report sent', () => {
  it('marks it sent and releases the claim in one write, after NCMEC has the finished CyberTip', async () => {
    await processCsamReport(report);

    expect(stamps()).toEqual([
      {
        where: { id: 1, sendClaimId: expect.any(String), reportSentAt: null },
        data: expect.objectContaining({
          reportId: 99,
          reportSentAt: expect.any(Date),
          sendClaimId: null,
          sendClaimedAt: null,
        }),
      },
    ]);
    expect(order(finishReport)).toBeLessThan(
      dbMock.dbWrite.csamReport.updateMany.mock.invocationCallOrder[
        claimWrites().indexOf(stamps()[0])
      ]
    );
    expect(releases()).toEqual([stamps()[0]]);
  });

  it('stores the CyberTip id on the unsent report before any file is sent', async () => {
    await processCsamReport(report);

    const persist = claimWrites().findIndex(({ data }) => data.reportId === 99);
    expect(claimWrites()[persist]).toEqual({
      where: { id: 1, sendClaimId: expect.any(String), reportSentAt: null },
      data: { reportId: 99 },
    });
    expect(dbMock.dbWrite.csamReport.updateMany.mock.invocationCallOrder[persist]).toBeLessThan(
      order(uploadFile)
    );
  });

  it('leaves the report unsent and retryable when the finish fails', async () => {
    finishReport.mockRejectedValue(new Error('synthetic finish failure'));

    await processCsamReport(report);

    expect(stamps()).toEqual([]);
    expect(cancelReport).toHaveBeenCalledWith({ id: 99 });
    expect(writesWith('details').at(-1)?.data).toEqual({
      reportId: null,
      details: { cancelledReportIds: [99] },
    });
    expect(releases()).toHaveLength(1);
  });

  it('builds the sent details on the row re-read under the claim, not on the run copy', async () => {
    primaryRow = { ...report, details: { writtenSinceClaim: true } } as CsamReportProps;

    await processCsamReport(report);

    expect(stamps()[0].data.details).toEqual(
      expect.objectContaining({ writtenSinceClaim: true, images: [expect.any(Object)] })
    );
  });

  it('archives only a sent report, so never one this run is still sending', async () => {
    await getCsamsToArchive();

    expect(dbMock.dbRead.csamReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ reportSentAt: { not: null } }),
      })
    );
  });

  it('logs the report id and the CyberTip id on every send line', async () => {
    await processCsamReport(report);

    for (const subType of ['send-open', 'send-upload', 'send-finish'])
      expect(lines(subType)).toEqual([expect.objectContaining({ reportId: 1, ncmecReportId: 99 })]);
  });
});

describe('a CyberTip an earlier run left open', () => {
  it('is cancelled, and noted on the report, before another is opened', async () => {
    primaryRow = { ...report, reportId: 77 } as CsamReportProps;

    await processCsamReport(report);

    expect(cancelReport).toHaveBeenCalledWith({ id: 77 });
    expect(order(cancelReport)).toBeLessThan(order(submitReport));
    expect(writesWith('details')[0].data).toEqual({
      reportId: null,
      details: { cancelledReportIds: [77] },
    });
    expect(lines('send-cancel')).toEqual([
      expect.objectContaining({ reportId: 1, ncmecReportId: 77 }),
    ]);
    expect(stamps()).toHaveLength(1);
  });

  it('is noted as a possible duplicate when it cannot be cancelled, and the report is sent again', async () => {
    primaryRow = { ...report, reportId: 77 } as CsamReportProps;
    cancelReport.mockRejectedValueOnce(new Error('already finished'));

    await processCsamReport(report);

    expect(lines('send-possible-duplicate')).toEqual([
      expect.objectContaining({ type: 'error', reportId: 1, ncmecReportId: 77 }),
    ]);
    expect(writesWith('details')[0].data).toEqual({
      reportId: null,
      details: { possibleDuplicateReportIds: [77] },
    });
    expect(submitReport).toHaveBeenCalledTimes(1);
    expect(stamps()).toHaveLength(1);
  });

  it('is unknown when the run died before storing its id, and the next run opens another', async () => {
    await processCsamReport(report);

    expect(cancelReport).not.toHaveBeenCalled();
    expect(submitReport).toHaveBeenCalledTimes(1);
    expect(stamps()).toHaveLength(1);
  });

  it('once cancelled after a failed send, is not cancelled again by the next run', async () => {
    finishReport.mockRejectedValueOnce(new Error('synthetic finish failure'));
    await processCsamReport(report);
    const afterFailure = writesWith('details').at(-1)?.data;
    primaryRow = { ...report, ...afterFailure } as CsamReportProps;
    cancelReport.mockClear();

    await processCsamReport(report);

    expect(cancelReport).not.toHaveBeenCalled();
    expect(stamps()).toHaveLength(1);
  });
});

describe('the claim', () => {
  it('leaves a report another run holds alone', async () => {
    dbMock.dbWrite.csamReport.updateMany.mockResolvedValueOnce({ count: 0 });

    await processCsamReport(report);

    expect(submitReport).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.csamReport.updateMany).toHaveBeenCalledTimes(1);
    expect(lines('send-claim-held')).toEqual([expect.objectContaining({ reportId: 1 })]);
  });

  it('takes the report only while unsent, and unclaimed or past the claim expiry', async () => {
    await processCsamReport(report);

    expect(claimWrites()[0]).toEqual({
      where: {
        id: 1,
        reportSentAt: null,
        OR: [{ sendClaimId: null }, { sendClaimedAt: { lt: expect.any(Date) } }],
      },
      data: { sendClaimId: expect.any(String), sendClaimedAt: expect.any(Date) },
    });
  });

  it('when lost before the CyberTip id is stored, cancels the CyberTip and sends nothing', async () => {
    dbMock.dbWrite.csamReport.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await processCsamReport(report);

    expect(uploadFile).not.toHaveBeenCalled();
    expect(cancelReport).toHaveBeenCalledWith({ id: 99 });
    expect(lines('send-claim-lost')).toEqual([
      expect.objectContaining({ type: 'error', reportId: 1, ncmecReportId: 99 }),
    ]);
    expect(dbMock.dbWrite.csamReport.updateMany).toHaveBeenCalledTimes(2);
  });

  it('when lost before the report is marked sent, raises send-stamp-lost with both ids', async () => {
    dbMock.dbWrite.csamReport.updateMany.mockImplementation(async ({ data }) => ({
      count: 'reportSentAt' in data ? 0 : 1,
    }));

    await processCsamReport(report);

    expect(finishReport).toHaveBeenCalledWith({ id: 99 });
    expect(lines('send-stamp-lost')).toEqual([
      expect.objectContaining({ type: 'error', reportId: 1, ncmecReportId: 99 }),
    ]);
    expect(releases()).toHaveLength(1);
  });
});

describe('deleting a report the send finds nothing to send for', () => {
  it.each([
    ['Image', { images: [{ id: 601 }] }, { images: [{ id: 601 }, { id: 501 }] }],
    [
      'GeneratedImage',
      { details: {} },
      { details: { generatedImages: [{ jobId: 'job-1', blobs: [{ url: 'blob-1' }] }] } },
    ],
    [
      'TrainingData',
      { details: { modelVersionIds: [6] } },
      { details: { modelVersionIds: [6, 7] } },
    ],
  ])(
    'deletes no %s report that evidence was folded into after the run read it',
    async (type, runCopy, primaryCopy) => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      const runStart = { ...report, type, ...runCopy } as unknown as CsamReportProps;
      primaryRow = { ...report, type, ...primaryCopy } as unknown as CsamReportProps;

      await processCsamReport(runStart);

      expect(dbMock.dbWrite.csamReport.deleteMany).not.toHaveBeenCalled();
      expect(submitReport).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['Image', { images: [{ id: 601 }] }],
    ['GeneratedImage', { details: {} }],
    ['TrainingData', { details: { modelVersionIds: [6] } }],
    ['ExternalLink', { userId: null, details: {} }],
  ])('deletes a %s report only under the claim', async (type, copy) => {
    primaryRow = { ...report, type, ...copy } as unknown as CsamReportProps;

    await processCsamReport(primaryRow);

    expect(dbMock.dbWrite.csamReport.deleteMany).toHaveBeenCalledWith({
      where: { id: 1, sendClaimId: expect.any(String), reportSentAt: null },
    });
    expect(submitReport).not.toHaveBeenCalled();
    expect(releases()).toEqual([]);
  });

  it('logs the report id when the delete is refused because the claim was lost', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.csamReport.deleteMany.mockResolvedValue({ count: 0 });

    await processCsamReport(report);

    expect(lines('send-delete-refused')).toEqual([
      expect.objectContaining({ type: 'error', reportId: 1 }),
    ]);
  });
});
