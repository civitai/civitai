import { TRPCError } from '@trpc/server';
import JSZip from 'jszip';
import type { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as ModelFileService from '~/server/services/model-file.service';
import type * as S3Utils from '~/utils/s3-utils';

/** A Training Studio publish leaves a 0-byte `Training Data` placeholder; the archive job must turn
 *  it into the run's real dataset zip, or say plainly that it can't. */

const uploads = vi.hoisted(() => ({ stored: [] as Buffer[], aborted: 0 }));
vi.mock('@aws-sdk/lib-storage', () => {
  const Upload = class {
    private body: Readable;
    constructor({ params }: { params: { Body: Readable } }) {
      this.body = params.Body;
    }
    async done() {
      const chunks: Buffer[] = [];
      for await (const chunk of this.body) chunks.push(chunk as Buffer);
      uploads.stored.push(Buffer.concat(chunks));
    }
    async abort() {
      uploads.aborted += 1;
    }
  };
  return { Upload, default: { Upload } };
});
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getUploadS3Client: () => ({}),
  getUploadBucket: () => 'bucket',
  getGetUrlByKey: async (key: string) => ({ url: `https://storage.example/bucket/${key}?sig=1` }),
}));
const registerFileLocation = vi.hoisted(() => vi.fn());
vi.mock('~/utils/storage-resolver', () => ({ registerFileLocation }));
const getOrchestratorToken = vi.hoisted(() => vi.fn());
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({ getOrchestratorToken }));
vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: () => ({ getConfig: () => ({ baseUrl: 'https://orch.example/' }) }),
}));
const getWorkflow = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/orchestrator/workflows', () => ({ getWorkflow }));
vi.mock('~/server/services/model-file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelFileService>()),
  deleteFilesForModelVersionCache: async () => undefined,
}));

const { archiveStudioDataset } = await import(
  '~/server/services/orchestrator/training/studio-dataset-archive.service'
);

const placeholder = (
  metadata: Record<string, unknown> = {},
  owner: { bannedAt: Date | null; deletedAt: Date | null } = { bannedAt: null, deletedAt: null }
) => ({
  id: 7,
  sizeKB: 0,
  modelVersionId: 70,
  metadata: {
    selectedEpochUrl: 'https://orch.example/v2/consumer/blobs/E.safetensors',
    ...metadata,
  },
  modelVersion: {
    model: { id: 700, userId: 5, meta: { trainingStudioWorkflowId: 'wf-1' }, user: owner },
  },
});

const workflowWith = (items: { air: string; caption?: string }[]) => ({
  id: 'wf-1',
  steps: [{ $type: 'training', input: { trainingData: { type: 'blobs', items } } }],
});

const fetchMock = vi.fn();
const blobResponse = (bytes: string, contentType: string) =>
  new Response(bytes, { status: 200, headers: { 'content-type': contentType } });

beforeEach(() => {
  uploads.stored = [];
  uploads.aborted = 0;
  registerFileLocation.mockReset().mockResolvedValue(undefined);
  getWorkflow.mockReset();
  getOrchestratorToken.mockReset().mockResolvedValue('owner-token');
  envMock.set({ ORCHESTRATOR_ACCESS_TOKEN: 'service-token' });
  loggingMock.logToAxiom.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  dbMock.dbWrite.modelFile.findUnique.mockReset();
  dbMock.dbWrite.modelFile.update.mockReset().mockResolvedValue({});
  dbMock.dbWrite.modelFile.updateMany.mockReset().mockResolvedValue({ count: 1 });
});

describe('archiveStudioDataset', () => {
  it('stores the dataset as a zip of every fetchable blob with its caption, and points the file at it', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(placeholder());
    getWorkflow.mockResolvedValue(
      workflowWith([
        { air: 'urn:air:other:blob@AAA.png', caption: 'a red fox' },
        { air: 'https://orch.example/v2/consumer/blobs/BBB.jpeg?sig=x', caption: 'gone' },
        { air: 'CCC', caption: '  ' },
      ])
    );
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/AAA.png')) return blobResponse('png-bytes', 'image/png');
      if (url.includes('/BBB.jpeg')) return new Response('', { status: 404 });
      if (url.includes('/CCC')) return blobResponse('webp-bytes', 'image/webp');
      throw new Error(`unexpected ${url}`);
    });

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({
      outcome: 'archived',
      items: 2,
      skipped: 1,
    });

    expect(uploads.stored).toHaveLength(1);
    const zip = await JSZip.loadAsync(uploads.stored[0]);
    expect(Object.keys(zip.files).sort()).toEqual(['01.png', '01.txt', '03.webp']);
    expect(await zip.file('01.png')!.async('string')).toBe('png-bytes');
    expect(await zip.file('01.txt')!.async('string')).toBe('a red fox');

    const { where, data } = dbMock.dbWrite.modelFile.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: 7, sizeKB: 0 });
    expect(data).toMatchObject({
      url: expect.stringMatching(
        /^https:\/\/storage\.example\/bucket\/training-images\/5\/.+\.zip$/
      ),
      exists: true,
      visibility: 'Private',
      metadata: {
        selectedEpochUrl: 'https://orch.example/v2/consumer/blobs/E.safetensors',
        numImages: 2,
        numCaptions: 1,
        datasetArchive: { status: 'archived', items: 2, skipped: 1 },
      },
    });
    expect(data.sizeKB).toBeGreaterThan(0);
    expect(registerFileLocation).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 7, modelVersionId: 70, modelId: 700 })
    );
  });

  it('marks the placeholder unavailable when the run is gone, without uploading anything', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(placeholder());
    getWorkflow.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'unavailable' });

    expect(uploads.stored).toHaveLength(0);
    expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelFile.update.mock.calls[0][0].data.metadata).toMatchObject({
      datasetArchive: { status: 'unavailable' },
    });
  });

  it('never stores an empty zip: a run whose blobs all fail is retried, then given up on', async () => {
    getWorkflow.mockResolvedValue(workflowWith([{ air: 'AAA.png', caption: 'x' }]));
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));

    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(placeholder());
    await expect(archiveStudioDataset(7)).resolves.toMatchObject({
      outcome: 'retry',
      attempts: 1,
    });
    expect(dbMock.dbWrite.modelFile.update.mock.calls[0][0].data.metadata).toMatchObject({
      datasetArchiveAttempts: 1,
    });

    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(
      placeholder({ datasetArchiveAttempts: 2 })
    );
    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'unavailable' });

    expect(uploads.stored).toHaveLength(0);
    expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
  });

  it('leaves a file alone once it is no longer a placeholder', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue({ ...placeholder(), sizeKB: 1234 });

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'skipped' });
    expect(getWorkflow).not.toHaveBeenCalled();
  });
});

describe('archiveStudioDataset for an owner who can no longer be minted a token', () => {
  const banned = { bannedAt: new Date(), deletedAt: null };
  const readTokens = () =>
    getWorkflow.mock.calls.map(([args]) => (args as { token: string }).token);

  beforeEach(() => {
    getWorkflow.mockResolvedValue(workflowWith([{ air: 'AAA.png', caption: 'x' }]));
    fetchMock.mockResolvedValue(blobResponse('png-bytes', 'image/png'));
  });

  it.each([
    ['banned', banned],
    ['deleted', { bannedAt: null, deletedAt: new Date() }],
  ])('archives a %s owner’s run with the service token, minting nothing', async (_, owner) => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(placeholder({}, owner));

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'archived' });
    expect(getOrchestratorToken).not.toHaveBeenCalled();
    expect(readTokens()).toEqual(['service-token']);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer service-token' },
    });
    expect(dbMock.dbWrite.modelFile.updateMany.mock.calls[0][0].data.visibility).toBe('Private');
  });

  it('still reads an owner in good standing with their own token', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(placeholder());

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'archived' });
    expect(getOrchestratorToken).toHaveBeenCalledWith(5);
    expect(readTokens()).toEqual(['owner-token']);
  });

  it.each([
    ['a failed read', new Error('orchestrator 500')],
    [
      'a not-found, which the service token cannot tell from no access',
      new TRPCError({ code: 'NOT_FOUND' }),
    ],
  ])('on %s: alerts, gives nothing up and leaves the item queued', async (_, failure) => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(
      placeholder({ datasetArchiveAttempts: 2 }, banned)
    );
    getWorkflow.mockRejectedValue(failure);

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'retry' });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'studio-dataset-archive-service-read-failed' })
    );
    // No metadata written: the row keeps matching the pending query, and nothing marks it gone.
    expect(dbMock.dbWrite.modelFile.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
    expect(uploads.stored).toHaveLength(0);
  });

  it('fails safe the same way when no service token is configured', async () => {
    envMock.set({ ORCHESTRATOR_ACCESS_TOKEN: '' });
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(placeholder({}, banned));

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'retry' });
    expect(getOrchestratorToken).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelFile.update).not.toHaveBeenCalled();
  });
});
