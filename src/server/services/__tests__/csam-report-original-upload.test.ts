import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CybertiplineTools from '@civitai/cybertipline-tools';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The NCMEC upload sends the stored original, and the report's sent-state update records what
 * was sent. All ids and bytes below are invented.
 */

const { uploadFile, submitFileDetails } = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  submitFileDetails: vi.fn(),
}));

vi.mock('@civitai/cybertipline-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof CybertiplineTools>()),
  Client: class {
    getStatus = async () => ({ data: { responseCode: 0 } });
    submitReport = async () => ({ data: { reportId: 99 } });
    uploadFile = uploadFile;
    submitFileDetails = submitFileDetails;
    finishReport = vi.fn();
    cancelReport = vi.fn();
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

const stored = Buffer.from('the bytes the user uploaded');
const getObjectKeys: string[] = [];
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getImageUploadBackend: async () => ({
    bucket: 'test-images',
    backend: 'backblaze',
    s3: {
      send: async (command: { input: { Key: string } }) => {
        getObjectKeys.push(command.input.Key);
        return {
          Body: { transformToByteArray: async () => new Uint8Array(stored) },
          ContentType: 'image/png',
          ContentLength: stored.length,
        };
      },
    },
  }),
}));

import type { CsamReportProps } from '~/server/services/csam.service-new';
import { processCsamReport } from '~/server/services/csam.service-new';

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

describe('NCMEC image upload', () => {
  beforeEach(() => {
    getObjectKeys.length = 0;
    uploadFile.mockReset().mockResolvedValue({ data: { fileId: 'file-1', hash: 'ncmec-md5' } });
    submitFileDetails.mockReset().mockResolvedValue({});
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

    expect(getObjectKeys).toEqual(['stored-key-501']);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    const file = uploadFile.mock.calls[0][0].file as File;
    expect(Buffer.from(await file.arrayBuffer()).equals(stored)).toBe(true);
    expect(file.type).toBe('image/png');
  });

  it('records the sha256 in the same update that marks the report sent', async () => {
    await processCsamReport(report);

    expect(dbMock.dbWrite.csamReport.update).toHaveBeenCalledTimes(1);
    const { data } = dbMock.dbWrite.csamReport.update.mock.calls[0][0];
    expect(data.reportSentAt).toBeInstanceOf(Date);
    expect(data.details.images).toEqual([
      expect.objectContaining({
        id: 501,
        fileId: 'file-1',
        hash: 'ncmec-md5',
        source: 'original',
        sha256: createHash('sha256').update(stored).digest('hex'),
        bytes: stored.length,
        contentType: 'image/png',
      }),
    ]);
  });
});
