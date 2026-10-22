import fs from 'fs';
import fsAsync from 'fs/promises';
import JSZip from 'jszip';
import type { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const {
  getStatus,
  submitReport,
  uploadFile,
  finishReport,
  cancelReport,
  getObject,
  fetchBlobAsFile,
  getFileForModelVersion,
} = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getFileForModelVersion: vi.fn(),
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
    getStatus = getStatus;
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
  getFileForModelVersion,
}));

import type { CsamReportProps } from '~/server/services/csam.service-new';
import {
  CSAM_SEND_DECISION_AFTER_HOURS,
  CSAM_SEND_SHORT_AFTER_HOURS,
  getCsamsToArchive,
  processCsamReport,
} from '~/server/services/csam.service-new';
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
  getStatus.mockReset().mockResolvedValue({ data: { responseCode: 0 } });
  getFileForModelVersion.mockReset().mockResolvedValue({ status: 'not-found' });
  submitReport.mockReset().mockResolvedValue({ data: { reportId: 99 } });
  uploadFile.mockReset().mockResolvedValue({ data: { fileId: 'file-1', hash: 'ncmec-md5' } });
  finishReport.mockReset().mockResolvedValue({});
  cancelReport.mockReset().mockResolvedValue({ data: { responseCode: 0 } });
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

afterEach(() => vi.restoreAllMocks());

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

  it('builds the sent details on the row re-read at the final write, not on the claimed copy', async () => {
    // Read back as claimed, then with a key written to it since.
    dbMock.dbWrite.csamReport.findFirst
      .mockResolvedValueOnce(report)
      .mockResolvedValue({ ...report, details: { writtenSinceClaim: true } });

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
      // No training-data directory is made or removed on disk.
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'rmSync').mockReturnValue(undefined);
      const runStart = { ...report, type, ...runCopy } as unknown as CsamReportProps;
      primaryRow = { ...report, type, ...primaryCopy } as unknown as CsamReportProps;

      await processCsamReport(runStart);

      expect(dbMock.dbWrite.csamReport.deleteMany).not.toHaveBeenCalled();
      // Past the delete branch: the CyberTip was opened, or (training data) the download was tried.
      expect(submitReport.mock.calls.length + getFileForModelVersion.mock.calls.length).toBe(1);
    }
  );

  it.each([
    ['Image', { images: [{ id: 601 }] }],
    ['TrainingData', { details: { modelVersionIds: [6] } }],
  ])('keeps a %s report whose evidence is gone, opening nothing', async (type, copy) => {
    primaryRow = { ...report, type, ...copy } as unknown as CsamReportProps;

    await processCsamReport(primaryRow);

    expect(dbMock.dbWrite.csamReport.deleteMany).not.toHaveBeenCalled();
    expect(submitReport).not.toHaveBeenCalled();
    expect(lines('send-no-files')).toEqual([
      expect.objectContaining({ type: 'error', reportId: 1 }),
    ]);
  });

  it.each([['ExternalLink', { userId: null, details: {} }]])(
    'deletes a %s report only under the claim',
    async (type, copy) => {
      primaryRow = { ...report, type, ...copy } as unknown as CsamReportProps;

      await processCsamReport(primaryRow);

      expect(dbMock.dbWrite.csamReport.deleteMany).toHaveBeenCalledWith({
        where: { id: 1, sendClaimId: expect.any(String), reportSentAt: null },
      });
      expect(submitReport).not.toHaveBeenCalled();
      expect(releases()).toEqual([]);
    }
  );

  it('logs the report id when the delete is refused because the claim was lost', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.csamReport.deleteMany.mockResolvedValue({ count: 0 });

    await processCsamReport(report);

    expect(lines('send-delete-refused')).toEqual([
      expect.objectContaining({ type: 'error', reportId: 1 }),
    ]);
  });
});

const theClaim = () => claimWrites()[0].data.sendClaimId;
const answering = (responseCode: number) => ({ data: { responseCode } });

describe("this run's CyberTip, after a failed send", () => {
  it('is cancelled again by the next run when its cancel fails, and two failed cancels open no third CyberTip', async () => {
    finishReport.mockRejectedValueOnce(new Error('synthetic finish failure'));
    cancelReport.mockRejectedValue(new Error('synthetic NCMEC outage'));
    submitReport
      .mockResolvedValueOnce({ data: { reportId: 99 } })
      .mockResolvedValueOnce({ data: { reportId: 100 } });

    await processCsamReport(report);

    expect(lines('send-cancel-failed')).toEqual([
      expect.objectContaining({ type: 'error', reportId: 1, ncmecReportId: 99 }),
    ]);
    expect(writesWith('details')).toEqual([]);

    primaryRow = { ...report, reportId: 99 } as CsamReportProps;
    await processCsamReport(report);

    expect(cancelReport).toHaveBeenLastCalledWith({ id: 99 });
    expect(lines('send-possible-duplicate')).toEqual([
      expect.objectContaining({ reportId: 1, ncmecReportId: 99, cancelOutcome: 'failed' }),
    ]);
    expect(submitReport).toHaveBeenCalledTimes(2);
    expect(stamps().map(({ data }) => data.reportId)).toEqual([100]);
  });

  it('is marked sent, not sent again, when NCMEC answers the cancel that it was already finished', async () => {
    finishReport.mockRejectedValue(new Error('synthetic finish timeout'));
    cancelReport.mockResolvedValue(answering(5102));

    await processCsamReport(report);

    expect(lines('send-cancel-already-finished')).toEqual([
      expect.objectContaining({ type: 'error', reportId: 1, ncmecReportId: 99 }),
    ]);
    expect(stamps().map(({ data }) => data.reportId)).toEqual([99]);
    expect(submitReport).toHaveBeenCalledTimes(1);
    expect(writesWith('details').filter(({ data }) => !('reportSentAt' in data))).toEqual([]);
  });

  it('is recorded as cancelled when NCMEC answers it was already retracted', async () => {
    finishReport.mockRejectedValue(new Error('synthetic finish failure'));
    cancelReport.mockResolvedValue(answering(5101));

    await processCsamReport(report);

    expect(stamps()).toEqual([]);
    expect(writesWith('details').at(-1)?.data).toEqual({
      reportId: null,
      details: { cancelledReportIds: [99] },
    });
    expect(lines('send-cancel-already-retracted')).toEqual([
      expect.objectContaining({ reportId: 1, ncmecReportId: 99 }),
    ]);
  });
});

describe('a stored CyberTip id NCMEC answers for', () => {
  it('is a possible duplicate when already finished, and the report is sent again', async () => {
    primaryRow = { ...report, reportId: 77 } as CsamReportProps;
    cancelReport.mockResolvedValueOnce(answering(5102));

    await processCsamReport(report);

    expect(lines('send-possible-duplicate')).toEqual([
      expect.objectContaining({ type: 'error', ncmecReportId: 77, cancelOutcome: 'finished' }),
    ]);
    expect(writesWith('details')[0].data.details).toEqual({ possibleDuplicateReportIds: [77] });
    expect(stamps()).toHaveLength(1);
  });

  it('is recorded as cancelled when already retracted', async () => {
    primaryRow = { ...report, reportId: 77 } as CsamReportProps;
    cancelReport.mockResolvedValueOnce(answering(5101));

    await processCsamReport(report);

    expect(lines('send-cancel-already-retracted')).toEqual([
      expect.objectContaining({ ncmecReportId: 77 }),
    ]);
    expect(writesWith('details')[0].data.details).toEqual({ cancelledReportIds: [77] });
  });

  it.each([
    ['cancelled', answering(0), { cancelledReportIds: [5, 77], possibleDuplicateReportIds: [6] }],
    ['finished', answering(5102), { cancelledReportIds: [5], possibleDuplicateReportIds: [6, 77] }],
  ])('when %s, is added to the ids the report already notes', async (_, answer, noted) => {
    primaryRow = {
      ...report,
      reportId: 77,
      details: { cancelledReportIds: [5], possibleDuplicateReportIds: [6] },
    } as CsamReportProps;
    cancelReport.mockResolvedValueOnce(answer);

    await processCsamReport(report);

    expect(writesWith('details')[0].data.details).toEqual(noted);
  });
});

describe('a report that may have a CyberTip at NCMEC', () => {
  it.each([
    ['cancelled', answering(0)],
    ['already retracted', answering(5101)],
  ])('is deleted for having nothing to send once its stored CyberTip is %s', async (_, answer) => {
    cancelReport.mockResolvedValue(answer);
    primaryRow = { ...report, userId: null, reportId: 77 } as CsamReportProps;

    await processCsamReport(report);

    expect(dbMock.dbWrite.csamReport.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('names a CyberTip an earlier run left open when the report waits for having no file', async () => {
    primaryRow = {
      ...report,
      type: 'GeneratedImage',
      reportId: 77,
      details: { generatedImages: [] },
    } as unknown as CsamReportProps;

    await processCsamReport(primaryRow);

    expect(lines('send-no-files')).toEqual([expect.objectContaining({ ncmecReportId: 77 })]);
  });

  it('is not deleted when its stored CyberTip cannot be cancelled', async () => {
    cancelReport.mockRejectedValue(new Error('synthetic NCMEC outage'));
    primaryRow = { ...report, userId: null, reportId: 77 } as CsamReportProps;

    await processCsamReport(report);

    expect(dbMock.dbWrite.csamReport.deleteMany).not.toHaveBeenCalled();
    expect(lines('send-delete-held')).toHaveLength(1);
  });

  it('is kept, waiting, when a generated-image report names no generated-image list', async () => {
    primaryRow = { ...report, type: 'GeneratedImage', details: {} } as unknown as CsamReportProps;

    await processCsamReport(primaryRow);

    expect(submitReport).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.csamReport.deleteMany).not.toHaveBeenCalled();
    expect(lines('send-no-files')).toEqual([
      expect.objectContaining({ type: 'error', reportId: 1 }),
    ]);
  });

  it('has a stored CyberTip cancelled before it is deleted for having nothing to send', async () => {
    primaryRow = { ...report, userId: null, reportId: 77 } as CsamReportProps;

    await processCsamReport(report);

    expect(cancelReport).toHaveBeenCalledWith({ id: 77 });
    expect(order(cancelReport)).toBeLessThan(
      dbMock.dbWrite.csamReport.deleteMany.mock.invocationCallOrder[0]
    );
    expect(dbMock.dbWrite.csamReport.deleteMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a stored CyberTip NCMEC says is finished', { reportId: 77 }],
    ['a possible duplicate noted', { details: { possibleDuplicateReportIds: [6] } }],
  ])('is not deleted when it has %s and nothing to send', async (_, held) => {
    cancelReport.mockResolvedValue(answering(5102));
    primaryRow = { ...report, userId: null, ...held } as unknown as CsamReportProps;

    await processCsamReport(report);

    expect(dbMock.dbWrite.csamReport.deleteMany).not.toHaveBeenCalled();
    expect(lines('send-delete-held')).toEqual([
      expect.objectContaining({ type: 'error', reportId: 1 }),
    ]);
    expect(releases()).toEqual([
      {
        where: { id: 1, sendClaimId: theClaim() },
        data: { sendClaimId: null, sendClaimedAt: null },
      },
    ]);
  });
});

describe('a send that throws', () => {
  it('releases its claim, and only its own, when a read throws before any CyberTip is opened', async () => {
    dbMock.dbRead.image.findMany.mockRejectedValue(new Error('synthetic replica outage'));

    await expect(processCsamReport(report)).rejects.toThrow('synthetic replica outage');

    expect(releases()).toEqual([
      {
        where: { id: 1, sendClaimId: theClaim() },
        data: { sendClaimId: null, sendClaimedAt: null },
      },
    ]);
  });

  it('raises send-stamp-lost with both ids when the final write throws', async () => {
    dbMock.dbWrite.csamReport.updateMany.mockImplementation(async ({ data }) => {
      if ('reportSentAt' in data) throw new Error('synthetic write failure');
      return { count: 1 };
    });

    await expect(processCsamReport(report)).rejects.toThrow('synthetic write failure');

    expect(finishReport).toHaveBeenCalledWith({ id: 99 });
    expect(lines('send-stamp-lost')).toEqual([
      expect.objectContaining({ type: 'error', reportId: 1, ncmecReportId: 99 }),
    ]);
  });

  it('takes no claim while NCMEC is unavailable', async () => {
    getStatus.mockResolvedValue({ data: { responseCode: 1 } });

    await processCsamReport(report);

    expect(dbMock.dbWrite.csamReport.updateMany).not.toHaveBeenCalled();
  });
});

describe('sending each type of report', () => {
  const filedJobs = [
    { jobId: 'job-1', blobs: [{ url: 'blob-1' }], prompt: 'filed prompt', resources: ['r'] },
  ];

  it('sends a generated-image report, keeping the filed jobs and recording the uploads beside them', async () => {
    primaryRow = {
      ...report,
      type: 'GeneratedImage',
      details: { generatedImages: filedJobs },
    } as unknown as CsamReportProps;

    await processCsamReport(primaryRow);

    expect(stamps()[0].data.details).toEqual({
      generatedImages: filedJobs,
      generatedImageUploads: [{ url: 'blob-1', fileId: 'file-1', hash: 'ncmec-md5' }],
    });
    expect(order(finishReport)).toBeLessThan(
      dbMock.dbWrite.csamReport.updateMany.mock.invocationCallOrder[
        claimWrites().indexOf(stamps()[0])
      ]
    );
  });

  it.each([
    ['no job', []],
    ['jobs with no blob', [{ jobId: 'job-1', blobs: [] }]],
  ])(
    'opens no CyberTip for a generated-image report naming %s, and keeps it waiting',
    async (_, jobs) => {
      primaryRow = {
        ...report,
        type: 'GeneratedImage',
        details: { generatedImages: jobs },
      } as unknown as CsamReportProps;

      await processCsamReport(primaryRow);

      expect(submitReport).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.csamReport.deleteMany).not.toHaveBeenCalled();
      expect(lines('send-no-files')).toEqual([
        expect.objectContaining({ type: 'error', reportId: 1 }),
      ]);
      expect(lines('send-decision-needed')).toEqual([]);
      expect(releases()).toHaveLength(1);
    }
  );

  it('asks for a decision on a report with no file to send once it has waited past the decision limit', async () => {
    primaryRow = {
      ...report,
      type: 'GeneratedImage',
      createdAt: new Date(Date.now() - CSAM_SEND_DECISION_AFTER_HOURS * 3_600_000 - 60_000),
      reportId: 77,
      details: { generatedImages: [] },
    } as unknown as CsamReportProps;

    await processCsamReport(primaryRow);

    expect(lines('send-decision-needed')).toEqual([
      expect.objectContaining({ type: 'error', reportId: 1, ncmecReportId: 77 }),
    ]);
  });

  describe('training data', () => {
    async function zipOf(names: string[]) {
      const zip = new JSZip();
      for (const name of names) zip.file(name, 'bytes');
      return zip.generateAsync({ type: 'nodebuffer' });
    }
    async function serveZip(names: string[]) {
      const zip = await zipOf(names);
      getFileForModelVersion.mockResolvedValue({
        status: 'success',
        url: 'https://example.invalid/td.zip',
      });
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(new Uint8Array(zip)));
      // The zip passes through the job's disk; here, through memory.
      let written = Buffer.alloc(0);
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'rmSync').mockReturnValue(undefined);
      vi.spyOn(fsAsync, 'writeFile').mockImplementation(async (_, data) => {
        const chunks: Buffer[] = [];
        for await (const chunk of data as Readable) chunks.push(Buffer.from(chunk));
        written = Buffer.concat(chunks);
      });
      vi.spyOn(fs, 'readFile').mockImplementation(((
        _: unknown,
        done: (e: Error | null, data: Buffer) => void
      ) => done(null, written)) as never);
    }
    const trainingReport = {
      ...report,
      type: 'TrainingData',
      details: { modelVersionIds: [7] },
    } as unknown as CsamReportProps;

    it('sends it, recording each file NCMEC took', async () => {
      await serveZip(['a.png']);
      primaryRow = trainingReport;

      await processCsamReport(trainingReport);

      expect(stamps()[0].data.details).toEqual({
        modelVersionIds: [7],
        trainingData: [{ filename: 'a.png', fileId: 'file-1', hash: 'ncmec-md5' }],
      });
    });

    it('downloads its own copy even when one is already on disk', async () => {
      await serveZip(['a.png']);
      primaryRow = trainingReport;

      await processCsamReport(trainingReport);

      expect(getFileForModelVersion).toHaveBeenCalledTimes(1);
      expect(fsAsync.writeFile).toHaveBeenCalledTimes(1);
    });

    it('opens no CyberTip for a zip with no image in it', async () => {
      await serveZip(['notes.txt']);
      primaryRow = trainingReport;

      await processCsamReport(trainingReport);

      expect(submitReport).not.toHaveBeenCalled();
      expect(lines('send-no-files')).toEqual([
        expect.objectContaining({ type: 'error', reportId: 1 }),
      ]);
    });

    it('sends no queued file to a CyberTip being cancelled after one upload fails', async () => {
      await serveZip(['a.png', 'b.png', 'c.png', 'd.png']);
      uploadFile.mockRejectedValueOnce(new Error('synthetic upload failure'));
      primaryRow = trainingReport;

      await processCsamReport(trainingReport);

      expect(uploadFile).toHaveBeenCalledTimes(2);
      expect(Math.max(...uploadFile.mock.invocationCallOrder)).toBeLessThan(order(cancelReport));
      expect(stamps()).toEqual([]);
    });

    it('cancels only once an upload already in flight has finished', async () => {
      await serveZip(['a.png', 'b.png']);
      let inFlightDone = false;
      uploadFile
        .mockRejectedValueOnce(new Error('synthetic upload failure'))
        .mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          inFlightDone = true;
          return { data: { fileId: 'file-2', hash: 'ncmec-md5' } };
        });
      let doneAtCancel: boolean | undefined;
      cancelReport.mockImplementation(async () => {
        doneAtCancel = inFlightDone;
        return answering(0);
      });
      primaryRow = trainingReport;

      await processCsamReport(trainingReport);

      expect(doneAtCancel).toBe(true);
    });

    it('opens no CyberTip when the training data cannot be downloaded', async () => {
      await serveZip(['a.png']);
      getFileForModelVersion.mockResolvedValue({ status: 'not-found' });
      primaryRow = trainingReport;

      await processCsamReport(trainingReport);

      expect(submitReport).not.toHaveBeenCalled();
    });

    it.each([
      ['after a send', () => undefined],
      ['after a failed send', () => finishReport.mockRejectedValue(new Error('synthetic failure'))],
      ['when the send throws', () => submitReport.mockRejectedValue(new Error('synthetic outage'))],
    ])('removes its scratch copy %s', async (_, arrange) => {
      await serveZip(['a.png']);
      arrange();
      primaryRow = trainingReport;

      await processCsamReport(trainingReport).catch(() => undefined);

      expect(fs.rmSync).toHaveBeenCalledWith(expect.stringMatching(/training-data\/1$/), {
        recursive: true,
      });
    });
  });

  it.each([
    ['answers with an error', async () => null],
    [
      'throws',
      async () => {
        throw new Error('synthetic timeout');
      },
    ],
  ])(
    'opens no CyberTip for a generated-image report a job of which has no file: the fetch %s',
    async (_, gone) => {
      fetchBlobAsFile.mockImplementation(async (url: string) =>
        url === 'blob-gone' ? gone() : new File(['generated'], 'generated.png')
      );
      primaryRow = {
        ...report,
        type: 'GeneratedImage',
        details: {
          generatedImages: [
            { jobId: 'job-1', blobs: [{ url: 'blob-1' }] },
            { jobId: 'job-2', blobs: [{ url: 'blob-gone' }] },
          ],
        },
      } as unknown as CsamReportProps;

      await processCsamReport(primaryRow);

      expect(submitReport).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.csamReport.deleteMany).not.toHaveBeenCalled();
      expect(lines('archive-data')).toEqual([expect.objectContaining({ reportId: 1 })]);
      expect(dbMock.dbWrite.$executeRaw.mock.calls.at(-1)?.[1]).toBe(
        JSON.stringify({ 'blob-gone': 1 })
      );
      // An error response must come back as no file, not as the file.
      expect(fetchBlobAsFile).toHaveBeenCalledWith('blob-gone', undefined, { requireOk: true });
    }
  );

  describe('a generated image that cannot be fetched', () => {
    const twoJobs = (hoursAgo: number, readFailures: Record<string, number> = {}) =>
      ({
        ...report,
        type: 'GeneratedImage',
        createdAt: new Date(Date.now() - hoursAgo * 3_600_000 - 60_000),
        details: {
          readFailures,
          generatedImages: [
            { jobId: 'job-1', blobs: [{ url: 'blob-1' }] },
            { jobId: 'job-2', blobs: [{ url: 'blob-gone' }] },
          ],
        },
      } as unknown as CsamReportProps);
    beforeEach(() =>
      fetchBlobAsFile.mockImplementation(async (url: string) =>
        url === 'blob-gone' ? null : new File(['generated'], 'generated.png')
      )
    );

    it('is sent without past the short-send limit on its second failed fetch, and NCMEC is told', async () => {
      primaryRow = twoJobs(CSAM_SEND_SHORT_AFTER_HOURS, { 'blob-gone': 1 });

      await processCsamReport(primaryRow);

      expect(submitReport.mock.calls[0][0].additionalInfo).toBe(
        '1 file(s) named in this report could not be read from storage after repeated attempts and are not included.'
      );
      expect(stamps()[0].data.details).toMatchObject({
        readFailures: { 'blob-gone': 2 },
        generatedImageUploads: [{ url: 'blob-1', fileId: 'file-1', hash: 'ncmec-md5' }],
      });
      expect(lines('send-short')).toEqual([
        expect.objectContaining({ type: 'error', reportId: 1, filesMissing: 1 }),
      ]);
    });

    it('holds the report before the short-send limit, however often the file failed', async () => {
      primaryRow = twoJobs(CSAM_SEND_SHORT_AFTER_HOURS - 1, { 'blob-gone': 5 });

      await processCsamReport(primaryRow);

      expect(submitReport).not.toHaveBeenCalled();
    });

    it('counts a URL the filing names twice as one file', async () => {
      primaryRow = {
        ...twoJobs(1),
        details: {
          generatedImages: [
            { jobId: 'job-1', blobs: [{ url: 'blob-1' }, { url: 'blob-gone' }] },
            { jobId: 'job-2', blobs: [{ url: 'blob-gone' }] },
          ],
        },
      } as unknown as CsamReportProps;

      await processCsamReport(primaryRow);

      expect(dbMock.dbWrite.$executeRaw.mock.calls.at(-1)?.[1]).toBe(
        JSON.stringify({ 'blob-gone': 1 })
      );
    });

    it.each([
      ['first', [false, true]],
      ['second', [true, false]],
    ])('sends a URL the filing names twice when only its %s fetch failed', async (_, fetched) => {
      let fetches = 0;
      fetchBlobAsFile.mockImplementation(async () =>
        fetched[fetches++] ? new File(['generated'], 'generated.png') : null
      );
      primaryRow = {
        ...twoJobs(1),
        details: {
          generatedImages: [
            { jobId: 'job-1', blobs: [{ url: 'blob-twice' }] },
            { jobId: 'job-2', blobs: [{ url: 'blob-twice' }] },
          ],
        },
      } as unknown as CsamReportProps;

      await processCsamReport(primaryRow);

      expect(fetches).toBe(2);
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(submitReport.mock.calls[0][0].additionalInfo).toBeUndefined();
      expect(stamps()[0].data.details).toMatchObject({
        generatedImageUploads: [{ url: 'blob-twice', fileId: 'file-1' }],
      });
      expect(stamps()[0].data.details).not.toHaveProperty(['readFailures', 'blob-twice']);
    });

    it('waits for an upload in flight before cancelling', async () => {
      fetchBlobAsFile.mockResolvedValue(new File(['generated'], 'generated.png'));
      let inFlightDone = false;
      uploadFile
        .mockRejectedValueOnce(new Error('synthetic upload failure'))
        .mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          inFlightDone = true;
          return { data: { fileId: 'file-2', hash: 'ncmec-md5' } };
        });
      let doneAtCancel: boolean | undefined;
      cancelReport.mockImplementation(async () => {
        doneAtCancel = inFlightDone;
        return answering(0);
      });
      primaryRow = twoJobs(1);

      await processCsamReport(primaryRow);

      expect(doneAtCancel).toBe(true);
    });

    it('holds the report at the short-send limit on the first failed fetch of that file', async () => {
      primaryRow = twoJobs(CSAM_SEND_SHORT_AFTER_HOURS);

      await processCsamReport(primaryRow);

      expect(submitReport).not.toHaveBeenCalled();
    });

    it('keeps a report none of whose generated images can be fetched, waiting', async () => {
      fetchBlobAsFile.mockResolvedValue(null);
      primaryRow = twoJobs(CSAM_SEND_SHORT_AFTER_HOURS, { 'blob-1': 5, 'blob-gone': 5 });

      await processCsamReport(primaryRow);

      expect(submitReport).not.toHaveBeenCalled();
      expect(lines('send-no-files')).toHaveLength(1);
    });
  });

  it('sends an external-link report that names no evidence file', async () => {
    primaryRow = {
      ...report,
      type: 'ExternalLink',
      details: { email: 'x@example.invalid' },
    } as unknown as CsamReportProps;

    await processCsamReport(primaryRow);

    expect(finishReport).toHaveBeenCalledWith({ id: 99 });
    expect(stamps()).toHaveLength(1);
  });
});

describe('the note to NCMEC on what a CyberTip omits', () => {
  it('counts an image the report names whose row no longer exists', async () => {
    primaryRow = { ...report, images: [{ id: 501 }, { id: 601 }] } as CsamReportProps;

    await processCsamReport(report);

    expect(submitReport.mock.calls[0][0].additionalInfo).toBe(
      '1 file(s) named in this report are no longer stored and are not included.'
    );
  });
});

describe('a cancel NCMEC refuses with an error naming its answer', () => {
  const refused = (name: string) =>
    new Error(`Request failed with http status 409 - ${name} (Request-ID: test)`);

  it("marks this run's CyberTip sent when the refusal says it was already finished", async () => {
    finishReport.mockRejectedValue(new Error('synthetic finish timeout'));
    cancelReport.mockRejectedValue(refused('ReportAlreadyFinished'));

    await processCsamReport(report);

    expect(lines('send-cancel-already-finished')).toHaveLength(1);
    expect(stamps().map(({ data }) => data.reportId)).toEqual([99]);
  });

  it.each([
    ['ReportAlreadyFinished', { possibleDuplicateReportIds: [77] }],
    ['ReportAlreadyRetracted', { cancelledReportIds: [77] }],
  ])('notes a stored CyberTip refused as %s', async (name, noted) => {
    primaryRow = { ...report, reportId: 77 } as CsamReportProps;
    cancelReport.mockRejectedValueOnce(refused(name));

    await processCsamReport(report);

    expect(writesWith('details')[0].data.details).toEqual(noted);
  });
});

describe('a finish NCMEC answers was retracted', () => {
  it('is not taken as finished: the report is not marked sent', async () => {
    finishReport.mockResolvedValue(answering(5101));
    cancelReport.mockResolvedValue(answering(5101));

    await processCsamReport(report);

    expect(stamps()).toEqual([]);
    expect(writesWith('details').at(-1)?.data.details).toEqual({ cancelledReportIds: [99] });
  });
});
