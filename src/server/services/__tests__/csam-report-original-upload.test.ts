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
  createdAt: new Date('2026-01-01T00:00:00Z'),
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

  describe('a send that keeps failing', () => {
    const failingReport = (hoursAgo: number) =>
      ({
        ...report,
        createdAt: new Date(Date.now() - hoursAgo * 3_600_000 - 60_000),
      } as CsamReportProps);
    const loggedLines = () =>
      vi.mocked(logToAxiom).mock.calls.map(([payload]) => payload as Record<string, unknown>);

    beforeEach(() => {
      vi.mocked(logToAxiom).mockClear();
      getObject.mockRejectedValue(
        Object.assign(new Error('synthetic storage outage'), {
          name: 'InternalError',
          $metadata: { httpStatusCode: 500 },
        })
      );
    });

    it('names the report and how long it has been pending', async () => {
      await processCsamReport(failingReport(2));

      expect(loggedLines()).toEqual([
        expect.objectContaining({ type: 'error', reportId: report.id, hoursPending: 2 }),
      ]);
    });

    it('raises a distinct blocked line once it has been pending past the threshold', async () => {
      await processCsamReport(failingReport(CSAM_SEND_BLOCKED_AFTER_HOURS - 1));
      expect(loggedLines().some((line) => line.subType === 'send-blocked')).toBe(false);

      await processCsamReport(failingReport(CSAM_SEND_BLOCKED_AFTER_HOURS));
      expect(loggedLines().filter((line) => line.subType === 'send-blocked')).toEqual([
        expect.objectContaining({
          reportId: report.id,
          hoursPending: CSAM_SEND_BLOCKED_AFTER_HOURS,
        }),
      ]);
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
