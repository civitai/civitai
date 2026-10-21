import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CybertiplineTools from '@civitai/cybertipline-tools';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The NCMEC upload sends the stored original, and the report's sent-state update records what
 * was sent. All ids and bytes below are invented.
 */

// `isProd: true` below makes this client variable required at module scope; a local `.env` hides
// that, CI does not.
await vi.hoisted(async () => {
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://example.invalid/civitai-link';
});

const { uploadFile, submitFileDetails, finishReport, cancelReport, getObject } = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  submitFileDetails: vi.fn(),
  finishReport: vi.fn(),
  cancelReport: vi.fn(),
  getObject: vi.fn(),
}));

vi.mock('@civitai/cybertipline-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof CybertiplineTools>()),
  Client: class {
    getStatus = async () => ({ data: { responseCode: 0 } });
    submitReport = async () => ({ data: { reportId: 99 } });
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
    s3: { send: (command: { input: { Key: string } }) => getObject(command.input.Key) },
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

const sentUpdate = () => dbMock.dbWrite.csamReport.update.mock.calls[0]?.[0]?.data;

describe('NCMEC image upload', () => {
  beforeEach(() => {
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
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network fetch'));
    dbMock.dbRead.user.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
      where.id === 10
        ? { id: 10, email: 'mod@example.invalid', name: 'Mod', isModerator: true }
        : { id: 20, email: 'user@example.invalid', name: 'User', username: 'user' }
    );
    dbMock.dbRead.image.findMany.mockResolvedValue([
      {
        id: 501,
        url: 'stored-key-501',
        name: 'upload.png',
        type: 'image',
        mimeType: 'image/png',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        meta: {},
        post: null,
        tags: [],
      },
    ]);
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
    dbMock.dbWrite.csamReport.update.mockReset().mockResolvedValue({});
    dbMock.dbWrite.$executeRaw.mockReset().mockResolvedValue(1);
  });

  it('uploads the stored original bytes', async () => {
    await processCsamReport(report);

    expect(getObject).toHaveBeenCalledWith('stored-key-501');
    expect(uploadFile).toHaveBeenCalledTimes(1);
    const file = uploadFile.mock.calls[0][0].file as File;
    expect(Buffer.from(await file.arrayBuffer()).equals(stored)).toBe(true);
    expect(file.type).toBe('image/webp');
  });

  it('records the sha256 in the same update that marks the report sent', async () => {
    await processCsamReport(report);

    expect(dbMock.dbWrite.csamReport.update).toHaveBeenCalledTimes(1);
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

  it('cancels and leaves the report unsent when the stored original cannot be read', async () => {
    getObject.mockRejectedValue(
      Object.assign(new Error('synthetic storage outage'), {
        name: 'InternalError',
        $metadata: { httpStatusCode: 500 },
      })
    );

    await processCsamReport(report);

    expect(uploadFile).not.toHaveBeenCalled();
    expect(cancelReport).toHaveBeenCalledTimes(1);
    expect(finishReport).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
  });

  describe('a report still unsent after the send run', () => {
    const filedHoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000 - 60_000);

    beforeEach(() => {
      vi.mocked(logToAxiom).mockClear();
    });

    it('raises a blocked line for each one pending past the threshold, read from the primary', async () => {
      dbMock.dbWrite.csamReport.findMany.mockResolvedValue([
        { id: 1, createdAt: filedHoursAgo(CSAM_SEND_BLOCKED_AFTER_HOURS - 1) },
        { id: 2, createdAt: filedHoursAgo(CSAM_SEND_BLOCKED_AFTER_HOURS) },
      ]);

      await logBlockedCsamReports([1, 2, 3]);

      expect(dbMock.dbWrite.csamReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: [1, 2, 3] }, reportSentAt: null } })
      );
      const blocked = vi
        .mocked(logToAxiom)
        .mock.calls.map(([payload]) => payload as Record<string, unknown>)
        .filter((line) => line.subType === 'send-blocked');
      expect(blocked).toEqual([
        expect.objectContaining({ reportId: 2, hoursPending: CSAM_SEND_BLOCKED_AFTER_HOURS }),
      ]);
    });
  });

  describe('a file that stays unreadable', () => {
    const storageOutage = () =>
      Object.assign(new Error('synthetic storage outage'), {
        name: 'InternalError',
        $metadata: { httpStatusCode: 500 },
      });
    const filed = (hours: number, readFailures?: Record<string, number>) =>
      ({
        ...report,
        images: [{ id: 501 }, { id: 502 }],
        createdAt: new Date(Date.now() - hours * 3_600_000 - 60_000),
        details: readFailures ? { readFailures } : {},
      } as CsamReportProps);
    const lines = (subType: string) =>
      vi
        .mocked(logToAxiom)
        .mock.calls.map(([payload]) => payload as Record<string, unknown>)
        .filter((line) => line.subType === subType);
    const recordedFailures = () =>
      dbMock.dbWrite.$executeRaw.mock.calls.map(([strings, ...values]) => ({
        sql: (strings as string[]).join('?'),
        values,
      }));

    beforeEach(() => {
      vi.mocked(logToAxiom).mockClear();
      dbMock.dbRead.image.findMany.mockResolvedValue(
        [501, 502].map((id) => ({
          id,
          url: `stored-key-${id}`,
          name: 'upload.png',
          type: 'image',
          mimeType: 'image/png',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          meta: {},
          post: null,
          tags: [],
        }))
      );
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
      expect(cancelReport).toHaveBeenCalledTimes(1);
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
    });

    it('holds the report back before the limit, however often the file failed', async () => {
      await processCsamReport(filed(CSAM_SEND_SHORT_AFTER_HOURS - 1, { 502: 5 }));

      expect(cancelReport).toHaveBeenCalledTimes(1);
      expect(finishReport).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
    });

    it('holds the report back at the limit on the first failed read of that file, as after an outage', async () => {
      await processCsamReport(filed(CSAM_SEND_SHORT_AFTER_HOURS));

      expect(cancelReport).toHaveBeenCalledTimes(1);
      expect(finishReport).not.toHaveBeenCalled();
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
        expect.objectContaining({ reportId: report.id, filesMissing: 1 }),
      ]);
    });

    describe('when no file of the report can be read', () => {
      beforeEach(() => {
        getObject.mockRejectedValue(storageOutage());
      });

      it('alerts on the first run and never sends it short', async () => {
        await processCsamReport(filed(1));
        expect(lines('send-all-unreadable')).toEqual([
          expect.objectContaining({ reportId: report.id, hoursPending: 1 }),
        ]);

        await processCsamReport(filed(CSAM_SEND_SHORT_AFTER_HOURS + 1, { 501: 9, 502: 9 }));
        expect(finishReport).not.toHaveBeenCalled();
        expect(cancelReport).toHaveBeenCalledTimes(2);
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

  it('records an image missing from storage and from the edge, rather than dropping it', async () => {
    getObject.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('not found', { status: 404 }));

    await processCsamReport(report);

    expect(uploadFile).not.toHaveBeenCalled();
    expect(sentUpdate().details.images).toEqual([{ id: 501, source: 'missing' }]);
  });

  it('records an edge copy as such when the stored object is gone', async () => {
    const edge = Buffer.from('edge bytes');
    getObject.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(new Uint8Array(edge), { headers: { 'content-type': 'image/jpeg' } })
    );

    await processCsamReport(report);

    expect(sentUpdate().details.images).toEqual([
      expect.objectContaining({ id: 501, source: 'edge-fallback', sha256: sha256(edge) }),
    ]);
  });
});
