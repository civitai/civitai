import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CybertiplineTools from '@civitai/cybertipline-tools';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The NCMEC upload sends the stored original, and the report's sent-state update records what
 * was sent. All ids and bytes below are invented.
 */

// `isProd: true` makes `NEXT_PUBLIC_CIVITAI_LINK` required at module scope; a local `.env` hides
// that, CI does not.
await vi.hoisted(async () => {
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://example.invalid/civitai-link';
});

const {
  submitReport,
  uploadFile,
  submitFileDetails,
  finishReport,
  cancelReport,
  getObject,
  headObject,
} = vi.hoisted(() => ({
  submitReport: vi.fn(),
  uploadFile: vi.fn(),
  submitFileDetails: vi.fn(),
  finishReport: vi.fn(),
  cancelReport: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
}));

vi.mock('@civitai/cybertipline-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof CybertiplineTools>()),
  Client: class {
    getStatus = async () => ({ data: { responseCode: 0 } });
    submitReport = submitReport;
    uploadFile = uploadFile;
    submitFileDetails = submitFileDetails;
    finishReport = finishReport;
    cancelReport = cancelReport;
  },
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: undefined,
}));

// The sent-state update is written only in production.
vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isProd: true,
}));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getImageUploadBackend: async () => ({
    bucket: 'test-images',
    backend: 'backblaze',
    s3: {
      send: (command: { constructor: { name: string }; input: { Key: string } }) =>
        command.constructor.name === 'HeadObjectCommand'
          ? headObject(command.input.Key)
          : getObject(command.input.Key),
    },
  }),
}));

import type { CsamReportProps } from '~/server/services/csam.service-new';
import {
  CSAM_SEND_BLOCKED_AFTER_HOURS,
  CSAM_SEND_DECISION_AFTER_HOURS,
  CSAM_SEND_SHORT_AFTER_HOURS,
  logBlockedCsamReports,
  processCsamReport,
} from '~/server/services/csam.service-new';
import { logToAxiom } from '~/server/logging/client';

const stored = Buffer.from('the bytes the user uploaded');
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const storageOutage = () =>
  Object.assign(new Error('synthetic storage outage'), {
    name: 'InternalError',
    $metadata: { httpStatusCode: 500 },
  });
const goneFromStorage = () => Object.assign(new Error('gone'), { name: 'NoSuchKey' });

const report = {
  id: 1,
  userId: 20,
  reportedById: 10,
  type: 'Image',
  createdAt: new Date(Date.now() - 3_600_000),
  reportSentAt: null,
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

const sentUpdate = () => dbMock.dbWrite.csamReport.update.mock.calls[0]?.[0]?.data;
const lines = (subType: string) =>
  vi
    .mocked(logToAxiom)
    .mock.calls.map(([payload]) => payload as Record<string, unknown>)
    .filter((line) => line.subType === subType);

describe('NCMEC image upload', () => {
  beforeEach(() => {
    vi.mocked(logToAxiom).mockClear();
    submitReport.mockReset().mockResolvedValue({ data: { reportId: 99 } });
    uploadFile.mockReset().mockResolvedValue({ data: { fileId: 'file-1', hash: 'ncmec-md5' } });
    submitFileDetails.mockReset().mockResolvedValue({});
    finishReport.mockReset();
    cancelReport.mockReset();
    // Stored as webp while the row says png: the stored bytes' own type wins.
    getObject.mockReset().mockImplementation(async () => ({
      Body: { transformToByteArray: async () => new Uint8Array(stored) },
      ContentType: 'image/webp',
      ContentLength: stored.length,
    }));
    // A HEAD sees what a GET of the same key would.
    headObject.mockReset().mockImplementation(async (key: string) => {
      const object = await getObject(key);
      return { ContentLength: object.ContentLength, ContentType: object.ContentType };
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network fetch'));
    dbMock.dbRead.user.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
      where.id === 10
        ? { id: 10, email: 'mod@example.invalid', name: 'Mod', isModerator: true }
        : { id: 20, email: 'user@example.invalid', name: 'User', username: 'user' }
    );
    dbMock.dbRead.image.findMany.mockResolvedValue([imageRow(501)]);
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
    dbMock.dbWrite.csamReport.update.mockReset().mockResolvedValue({});
    dbMock.dbWrite.$executeRaw.mockReset().mockResolvedValue(1);
  });

  it('uploads the stored original bytes', async () => {
    await processCsamReport(report);

    expect(uploadFile).toHaveBeenCalledTimes(1);
    const file = uploadFile.mock.calls[0][0].file as File;
    expect(Buffer.from(await file.arrayBuffer()).equals(stored)).toBe(true);
    expect(file.type).toBe('image/webp');
  });

  it('records the sha256 in the same update that marks the report sent', async () => {
    await processCsamReport(report);

    expect(dbMock.dbWrite.csamReport.update).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(sentUpdate().reportSentAt).toBeInstanceOf(Date);
    expect(sentUpdate().details.images).toEqual([
      expect.objectContaining({
        id: 501,
        fileId: 'file-1',
        hash: 'ncmec-md5',
        source: 'original',
        sha256: sha256(stored),
        bytes: stored.length,
        contentType: 'image/webp',
      }),
    ]);
  });

  describe('a report that is held', () => {
    it('opens no CyberTip on any run while the stored original cannot be read', async () => {
      getObject.mockRejectedValue(storageOutage());

      for (const hours of [1, 6, CSAM_SEND_SHORT_AFTER_HOURS + 1])
        await processCsamReport({
          ...report,
          createdAt: new Date(Date.now() - hours * 3_600_000 - 60_000),
          details: { readFailures: { 501: hours } },
        } as CsamReportProps);

      expect(submitReport).not.toHaveBeenCalled();
      expect(cancelReport).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
    });

    it('opens once and cancels once when a file that checked out cannot then be read', async () => {
      headObject.mockResolvedValue({ ContentLength: stored.length });
      getObject.mockRejectedValue(storageOutage());

      await processCsamReport(report);

      expect(submitReport).toHaveBeenCalledTimes(1);
      expect(cancelReport).toHaveBeenCalledTimes(1);
      expect(cancelReport).toHaveBeenCalledWith({ id: 99 });
      expect(finishReport).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
      expect(lines('archive-data')).toEqual([
        expect.objectContaining({ reportId: report.id, ncmecReportId: 99 }),
      ]);
      expect(dbMock.dbWrite.$executeRaw.mock.calls.at(-1)?.slice(1)).toEqual([
        JSON.stringify({ 501: 1 }),
        report.id,
      ]);
    });

    it('cancels, and never finishes, when its only file is gone by the time it is read', async () => {
      headObject.mockResolvedValue({ ContentLength: stored.length });
      getObject.mockRejectedValue(goneFromStorage());
      vi.mocked(globalThis.fetch).mockImplementation(
        async () => new Response('not found', { status: 404 })
      );

      await processCsamReport(report);

      expect(submitReport).toHaveBeenCalledTimes(1);
      expect(cancelReport).toHaveBeenCalledTimes(1);
      expect(finishReport).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
    });

    it('records a file gone by the time it is read, and sends the rest', async () => {
      dbMock.dbRead.image.findMany.mockResolvedValue([imageRow(501), imageRow(502)]);
      headObject.mockResolvedValue({ ContentLength: stored.length });
      getObject.mockImplementation(async (key: string) => {
        if (key === 'stored-key-502') throw goneFromStorage();
        return {
          Body: { transformToByteArray: async () => new Uint8Array(stored) },
          ContentType: 'image/webp',
          ContentLength: stored.length,
        };
      });
      vi.mocked(globalThis.fetch).mockImplementation(
        async () => new Response('not found', { status: 404 })
      );

      await processCsamReport({ ...report, images: [{ id: 501 }, { id: 502 }] } as CsamReportProps);

      expect(finishReport).toHaveBeenCalledTimes(1);
      expect(sentUpdate().details.images).toEqual([
        expect.objectContaining({ id: 501, source: 'original' }),
        { id: 502, source: 'missing', reason: 'edge 404' },
      ]);
    });

    it('opens no CyberTip again for a file that checks out but keeps failing to read', async () => {
      headObject.mockResolvedValue({ ContentLength: stored.length });
      getObject.mockRejectedValue(storageOutage());
      const keptFailing = (hours: number) =>
        ({
          ...report,
          createdAt: new Date(Date.now() - hours * 3_600_000 - 60_000),
          details: { readFailures: { 501: 2 } },
        } as CsamReportProps);

      await processCsamReport(keptFailing(1));
      expect(submitReport).not.toHaveBeenCalled();

      await processCsamReport(keptFailing(CSAM_SEND_SHORT_AFTER_HOURS + 1));
      expect(submitReport).not.toHaveBeenCalled();
      expect(lines('send-all-unreadable')).toHaveLength(2);
    });

    it('stops reading the other files once one fails after opening', async () => {
      dbMock.dbRead.image.findMany.mockResolvedValue([501, 502, 503, 504].map(imageRow));
      headObject.mockResolvedValue({ ContentLength: stored.length });
      getObject.mockImplementation(async (key: string) => {
        if (key === 'stored-key-501') throw storageOutage();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          Body: { transformToByteArray: async () => new Uint8Array(stored) },
          ContentType: 'image/webp',
          ContentLength: stored.length,
        };
      });

      await processCsamReport({
        ...report,
        images: [{ id: 501 }, { id: 502 }, { id: 503 }, { id: 504 }],
      } as CsamReportProps);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(cancelReport).toHaveBeenCalledTimes(1);
      // 501 fails at once and 502 was already reading beside it; 503 and 504 never start.
      expect(getObject.mock.calls.map(([key]) => key).sort()).toEqual([
        'stored-key-501',
        'stored-key-502',
      ]);
    });

    it('logs both ids before cancelling, even when the cancel fails', async () => {
      headObject.mockResolvedValue({ ContentLength: stored.length });
      getObject.mockRejectedValue(storageOutage());
      cancelReport.mockRejectedValue(new Error('synthetic NCMEC outage'));

      await expect(processCsamReport(report)).rejects.toThrow('synthetic NCMEC outage');

      expect(lines('archive-data')).toEqual([
        expect.objectContaining({ reportId: report.id, ncmecReportId: 99 }),
      ]);
    });
  });

  describe('a report still unsent after the send run', () => {
    const filedHoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000 - 60_000);

    it('raises a blocked line for each one pending past the threshold, read from the primary', async () => {
      dbMock.dbWrite.csamReport.findMany.mockResolvedValue([
        { id: 1, createdAt: filedHoursAgo(CSAM_SEND_BLOCKED_AFTER_HOURS - 1) },
        { id: 2, createdAt: filedHoursAgo(CSAM_SEND_BLOCKED_AFTER_HOURS) },
      ]);

      await logBlockedCsamReports([1, 2, 3]);

      expect(dbMock.dbWrite.csamReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: [1, 2, 3] }, reportSentAt: null } })
      );
      expect(lines('send-blocked')).toEqual([
        expect.objectContaining({ reportId: 2, hoursPending: CSAM_SEND_BLOCKED_AFTER_HOURS }),
      ]);
    });
  });

  describe('a file that stays unreadable', () => {
    const filed = (hours: number, readFailures?: Record<string, number>) =>
      ({
        ...report,
        images: [{ id: 501 }, { id: 502 }],
        createdAt: new Date(Date.now() - hours * 3_600_000 - 60_000),
        details: readFailures ? { readFailures } : {},
      } as CsamReportProps);
    const recordedFailures = () =>
      dbMock.dbWrite.$executeRaw.mock.calls.map(([strings, ...values]) => ({
        sql: (strings as string[]).join('?'),
        values,
      }));

    beforeEach(() => {
      dbMock.dbRead.image.findMany.mockResolvedValue([imageRow(501), imageRow(502)]);
      getObject.mockImplementation(async (key: string) => {
        if (key === 'stored-key-502') throw storageOutage();
        return {
          Body: { transformToByteArray: async () => new Uint8Array(stored) },
          ContentType: 'image/webp',
          ContentLength: stored.length,
        };
      });
    });

    it('counts each failed read on the unsent report', async () => {
      await processCsamReport(filed(1, { 502: 3 }));

      expect(recordedFailures()).toEqual([
        {
          sql: expect.stringMatching(/WHERE id = \? AND "reportSentAt" IS NULL/),
          values: [JSON.stringify({ 502: 4 }), report.id],
        },
      ]);
      expect(submitReport).not.toHaveBeenCalled();
    });

    it('holds the report back before the limit, however often the file failed', async () => {
      await processCsamReport(filed(CSAM_SEND_SHORT_AFTER_HOURS - 1, { 502: 5 }));

      expect(submitReport).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
    });

    it('holds the report back at the limit on the first failed read of that file, as after an outage', async () => {
      await processCsamReport(filed(CSAM_SEND_SHORT_AFTER_HOURS));

      expect(submitReport).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
    });

    it('sends without it at the limit on its second failed read, keeping the readable file', async () => {
      await processCsamReport(filed(CSAM_SEND_SHORT_AFTER_HOURS, { 502: 1 }));

      expect(cancelReport).not.toHaveBeenCalled();
      expect(finishReport).toHaveBeenCalledTimes(1);
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(dbMock.dbWrite.csamReport.update).toHaveBeenCalledTimes(1);
      expect(sentUpdate().reportSentAt).toBeInstanceOf(Date);
      expect(sentUpdate().details.readFailures).toEqual({ 502: 2 });
      expect(sentUpdate().details.images).toEqual([
        expect.objectContaining({
          id: 501,
          fileId: 'file-1',
          source: 'original',
          sha256: sha256(stored),
        }),
        { id: 502, source: 'missing', reason: 'storage read failed after retries' },
      ]);
      expect(lines('send-short')).toEqual([
        expect.objectContaining({ reportId: report.id, filesMissing: 1, filesAbsent: 0 }),
      ]);
    });

    it('holds the report at the limit while any one unreadable file has failed only once', async () => {
      dbMock.dbRead.image.findMany.mockResolvedValue([imageRow(501), imageRow(502), imageRow(503)]);
      getObject.mockImplementation(async (key: string) => {
        if (key !== 'stored-key-501') throw storageOutage();
        return {
          Body: { transformToByteArray: async () => new Uint8Array(stored) },
          ContentType: 'image/webp',
          ContentLength: stored.length,
        };
      });

      await processCsamReport({
        ...filed(CSAM_SEND_SHORT_AFTER_HOURS, { 502: 1 }),
        images: [{ id: 501 }, { id: 502 }, { id: 503 }],
      } as CsamReportProps);

      expect(submitReport).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
    });

    it('holds a report whose only other file is gone, however often this one failed', async () => {
      getObject.mockImplementation(async (key: string) => {
        throw key === 'stored-key-501' ? goneFromStorage() : storageOutage();
      });
      vi.mocked(globalThis.fetch).mockImplementation(
        async () => new Response('not found', { status: 404 })
      );

      await processCsamReport(filed(CSAM_SEND_SHORT_AFTER_HOURS + 1, { 502: 9 }));

      expect(submitReport).not.toHaveBeenCalled();
      expect(lines('send-all-unreadable')).toEqual([
        expect.objectContaining({ filesUnreadable: 1, filesAbsent: 1 }),
      ]);
    });

    describe('when no file of the report can be read', () => {
      beforeEach(() => {
        getObject.mockRejectedValue(storageOutage());
      });

      it('alerts on the first run and never sends it short', async () => {
        await processCsamReport(filed(1));
        expect(lines('send-all-unreadable')).toEqual([
          expect.objectContaining({ reportId: report.id, hoursPending: 1, filesUnreadable: 2 }),
        ]);

        await processCsamReport(filed(CSAM_SEND_SHORT_AFTER_HOURS + 1, { 501: 9, 502: 9 }));
        expect(submitReport).not.toHaveBeenCalled();
        expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
      });

      it('asks for a decision once it has been blocked past the decision limit', async () => {
        await processCsamReport(filed(CSAM_SEND_DECISION_AFTER_HOURS - 1, { 501: 9, 502: 9 }));
        expect(lines('send-decision-needed')).toEqual([]);

        await processCsamReport(filed(CSAM_SEND_DECISION_AFTER_HOURS, { 501: 9, 502: 9 }));
        expect(lines('send-decision-needed')).toEqual([
          expect.objectContaining({
            reportId: report.id,
            hoursPending: CSAM_SEND_DECISION_AFTER_HOURS,
          }),
        ]);
      });
    });
  });

  describe('a file gone from storage and the edge', () => {
    beforeEach(() => {
      vi.mocked(globalThis.fetch).mockImplementation(
        async () => new Response('not found', { status: 404 })
      );
    });

    it('holds a report with no other file, as one with nothing readable', async () => {
      getObject.mockRejectedValue(goneFromStorage());

      await processCsamReport(report);

      expect(submitReport).not.toHaveBeenCalled();
      expect(lines('send-all-unreadable')).toEqual([
        expect.objectContaining({ reportId: report.id, filesUnreadable: 0, filesAbsent: 1 }),
      ]);
    });

    it('is recorded with its reason when another file is sent', async () => {
      dbMock.dbRead.image.findMany.mockResolvedValue([imageRow(501), imageRow(502)]);
      getObject.mockImplementation(async (key: string) => {
        if (key === 'stored-key-502') throw goneFromStorage();
        return {
          Body: { transformToByteArray: async () => new Uint8Array(stored) },
          ContentType: 'image/webp',
          ContentLength: stored.length,
        };
      });

      await processCsamReport({ ...report, images: [{ id: 501 }, { id: 502 }] } as CsamReportProps);

      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(sentUpdate().details.images).toEqual([
        expect.objectContaining({ id: 501, source: 'original' }),
        { id: 502, source: 'missing', reason: 'edge 404' },
      ]);
      expect(lines('send-short')).toEqual([
        expect.objectContaining({ reportId: report.id, filesMissing: 1, filesAbsent: 1 }),
      ]);
    });
  });

  it('records an edge copy as such when the stored object is gone', async () => {
    const edge = Buffer.from('edge bytes');
    getObject.mockRejectedValue(goneFromStorage());
    vi.mocked(globalThis.fetch).mockImplementation(
      async () => new Response(new Uint8Array(edge), { headers: { 'content-type': 'image/jpeg' } })
    );

    await processCsamReport(report);

    expect(sentUpdate().details.images).toEqual([
      expect.objectContaining({ id: 501, source: 'edge-fallback', sha256: sha256(edge) }),
    ]);
  });
});
