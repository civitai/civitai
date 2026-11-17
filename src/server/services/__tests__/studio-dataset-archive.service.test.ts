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
const ownerHeld = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/legal-hold.service', () => ({ ownerHeld, ownerHeldSql: () => '' }));
const submitTrainingDataScanSafe = vi.hoisted(() => vi.fn(async () => true));
vi.mock('~/server/services/training-data-scan.service', () => ({ submitTrainingDataScanSafe }));
vi.mock('~/server/services/model-file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelFileService>()),
  deleteFilesForModelVersionCache: async () => undefined,
}));

const { archiveStudioDataset, serviceRetryDelayMs } = await import(
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

const workflowWith = (
  items: { air: string; caption?: string }[],
  moderationStatus: string | undefined = 'approved'
) => ({
  id: 'wf-1',
  steps: [
    {
      $type: 'training',
      input: { trainingData: { type: 'blobs', items } },
      output: { moderationStatus },
    },
  ],
});

/** The swap's write: the one update that points the row at a zip. */
const swaps = () =>
  dbMock.dbWrite.modelFile.update.mock.calls
    .map(([args]) => args as { where: unknown; data: Record<string, unknown> })
    .filter((args) => 'url' in args.data);
/** The row the swap locks and re-reads, as the archive sees it at write time. */
const lockedRow = (metadata: Record<string, unknown> = {}) =>
  dbMock.dbWrite.$queryRaw.mockResolvedValue([
    {
      metadata: {
        selectedEpochUrl: 'https://orch.example/v2/consumer/blobs/E.safetensors',
        ...metadata,
      },
    },
  ]);

const fetchMock = vi.fn();
/** A blob the orchestrator rated `nsfwLevel` (PG unless a test says otherwise; null = unrated). */
const blobResponse = (bytes: string, contentType: string, nsfwLevel: string | null = 'pg') =>
  new Response(bytes, {
    status: 200,
    headers: { 'content-type': contentType, ...(nsfwLevel && { 'x-nsfw-level': nsfwLevel }) },
  });

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
  dbMock.dbWrite.$queryRaw.mockReset();
  lockedRow();
  ownerHeld.mockReset().mockResolvedValue(false);
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

    const [{ where, data }] = swaps();
    expect(where).toEqual({ id: 7 });
    // The row is locked only while it is still the placeholder.
    const [lockSql, ...lockValues] = dbMock.dbWrite.$queryRaw.mock.calls[0];
    expect(lockSql.join('?')).toMatch(/WHERE id = \? AND "sizeKB" = 0 FOR UPDATE/);
    expect(lockValues).toEqual([7]);
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
    expect(swaps()).toHaveLength(0);
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
    expect(swaps()).toHaveLength(0);
  });

  it('leaves a file alone once it is no longer a placeholder', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue({ ...placeholder(), sizeKB: 1234 });

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'skipped' });
    expect(getWorkflow).not.toHaveBeenCalled();
  });

  it('marks the new zip unscanned and sends it to the virus scan', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(placeholder());
    getWorkflow.mockResolvedValue(workflowWith([{ air: 'urn:air:other:blob@AAA.png' }]));
    fetchMock.mockImplementation(async () => blobResponse('png-bytes', 'image/png'));
    submitTrainingDataScanSafe.mockClear();

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'archived' });

    const [{ data }] = swaps();
    expect(data).toMatchObject({
      virusScanResult: 'Pending',
      virusScanMessage: null,
      scannedAt: null,
    });
    expect(submitTrainingDataScanSafe).toHaveBeenCalledWith(
      { fileId: 7, modelVersionId: 70, url: data.url },
      'studio-dataset-archive'
    );
  });

  it('sends nothing to the scan when the file was not swapped', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue({ ...placeholder(), sizeKB: 1234 });
    submitTrainingDataScanSafe.mockClear();

    await archiveStudioDataset(7);

    expect(submitTrainingDataScanSafe).not.toHaveBeenCalled();
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
    expect(swaps()[0].data.visibility).toBe('Private');
  });

  it('still reads an owner in good standing with their own token', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(placeholder());

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'archived' });
    expect(getOrchestratorToken).toHaveBeenCalledWith(5, undefined, { allowRestricted: true });
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
    // Backs off without giving up: nothing marks the row gone, so the pending query returns it later.
    const written = dbMock.dbWrite.modelFile.update.mock.calls[0][0].data.metadata;
    expect(written).not.toHaveProperty('datasetArchive');
    expect(written).toMatchObject({
      datasetArchiveAttempts: 2,
      datasetArchiveServiceAttempts: 1,
      datasetArchiveRetryAfter: expect.any(String),
    });
    expect(swaps()).toHaveLength(0);
    expect(uploads.stored).toHaveLength(0);
  });

  it('backs off longer on each failure, up to a day', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(
      placeholder({ datasetArchiveServiceAttempts: 3 }, banned)
    );
    getWorkflow.mockRejectedValue(new Error('orchestrator 500'));
    const before = Date.now();

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'retry', attempts: 4 });
    const { datasetArchiveRetryAfter } =
      dbMock.dbWrite.modelFile.update.mock.calls[0][0].data.metadata;
    expect(Date.parse(datasetArchiveRetryAfter) - before).toBeGreaterThanOrEqual(8 * 3_600_000);
    expect(serviceRetryDelayMs(1)).toBe(3_600_000);
    expect(serviceRetryDelayMs(30)).toBe(24 * 3_600_000);
  });

  it('does not give up on a run the service token reads as having no blob dataset', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(placeholder({}, banned));
    getWorkflow.mockResolvedValue({ id: 'wf-1', steps: [] });

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'retry' });
    expect(dbMock.dbWrite.modelFile.update.mock.calls[0][0].data.metadata).not.toHaveProperty(
      'datasetArchive'
    );
  });

  it('fails safe the same way when no service token is configured', async () => {
    envMock.set({ ORCHESTRATOR_ACCESS_TOKEN: '' });
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(placeholder({}, banned));

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'retry' });
    expect(getOrchestratorToken).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelFile.update.mock.calls[0][0].data.metadata).not.toHaveProperty(
      'datasetArchive'
    );
  });

  // The row was read before the ban; the next run sees it and takes the service-token path.
  it('does not count a ban landing mid-run against an owner in good standing', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(
      placeholder({ datasetArchiveAttempts: 2 })
    );
    getOrchestratorToken.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));

    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'retry', attempts: 2 });
    expect(dbMock.dbWrite.modelFile.update).not.toHaveBeenCalled();
  });
});

describe('archiveStudioDataset applies the owner’s sharing choice only to the real zip', () => {
  const items = [
    { air: 'AAA.png', caption: 'a' },
    { air: 'BBB.png', caption: 'b' },
  ];
  const shared = { ownRights: true, shareDataset: true };
  const archive = async () => {
    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'archived' });
    return swaps()[0].data.visibility;
  };

  beforeEach(() => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(placeholder());
    getWorkflow.mockResolvedValue(workflowWith(items));
    fetchMock.mockImplementation(async () => blobResponse('png-bytes', 'image/png'));
  });

  it('a shared, complete, approved dataset with nothing restricted is Public', async () => {
    lockedRow(shared);
    expect(await archive()).toBe('Public');
    expect(swaps()[0].data.metadata).toMatchObject({ datasetArchive: { complete: true } });
  });

  it('reads the choice at write time, not from the row it started with', async () => {
    // The choice landed while the zip was being built: only the locked re-read sees it.
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(placeholder({}));
    lockedRow(shared);
    expect(await archive()).toBe('Public');
  });

  it.each([
    ['rights, not shared', { ownRights: true, shareDataset: false }, 'Sensitive'],
    ['no choice', {}, 'Private'],
    ['shared without the rights', { ownRights: false, shareDataset: true }, 'Private'],
  ])('%s is %s', async (_, choice, expected) => {
    lockedRow(choice);
    expect(await archive()).toBe(expected);
  });

  it('a restricted owner or content keeps a shared dataset Private', async () => {
    lockedRow(shared);
    ownerHeld.mockResolvedValue(true);
    expect(await archive()).toBe('Private');
  });

  it('a run that is not approved keeps a shared dataset Private', async () => {
    lockedRow(shared);
    getWorkflow.mockResolvedValue(workflowWith(items, 'underReview'));
    expect(await archive()).toBe('Private');
  });

  it('a zip missing any item of the run keeps a shared dataset Private', async () => {
    lockedRow(shared);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/BBB.png')
        ? new Response('', { status: 404 })
        : blobResponse('png-bytes', 'image/png')
    );
    expect(await archive()).toBe('Private');
    expect(swaps()[0].data.metadata).toMatchObject({ datasetArchive: { complete: false } });
  });

  it('a run listing an item with no readable blob keeps a shared dataset Private', async () => {
    lockedRow(shared);
    getWorkflow.mockResolvedValue(
      workflowWith([...items, { air: 42 } as unknown as { air: string }])
    );
    expect(await archive()).toBe('Private');
    expect(swaps()[0].data.metadata).toMatchObject({
      datasetArchive: { items: 2, complete: false },
    });
  });

  it('records the zip’s rating from every item’s orchestrator rating', async () => {
    lockedRow(shared);
    fetchMock.mockImplementation(
      async (url: string) =>
        new Response('png-bytes', {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'x-nsfw-level': url.includes('/BBB') ? 'R' : 'pg',
          },
        })
    );
    await archive();
    expect(swaps()[0].data.metadata).toMatchObject({ nsfwLevel: 4 | 1 });
  });

  it('a fully rated SFW zip is Public and recorded as fully rated', async () => {
    lockedRow(shared);
    expect(await archive()).toBe('Public');
    expect(swaps()[0].data.metadata).toMatchObject({ nsfwLevel: 1, fullyRated: true });
  });

  it('a partly rated zip stays Private, and an unrated item does not hide a mature one', async () => {
    lockedRow(shared);
    fetchMock.mockImplementation(async (url: string) =>
      blobResponse('png-bytes', 'image/png', url.includes('/BBB') ? null : 'x')
    );
    expect(await archive()).toBe('Private');
    expect(swaps()[0].data.metadata).toMatchObject({ nsfwLevel: 8, fullyRated: false });
    expect(swaps()[0].data.metadata).toMatchObject({ datasetArchive: { complete: false } });
  });

  it('a zip with no rated item stays Private and records no rating', async () => {
    lockedRow(shared);
    fetchMock.mockImplementation(async () => blobResponse('png-bytes', 'image/png', null));
    expect(await archive()).toBe('Private');
    expect(swaps()[0].data.metadata).not.toHaveProperty('nsfwLevel');
    expect(swaps()[0].data.metadata).toMatchObject({ fullyRated: false });
  });

  it('a file swapped in while the zip was built is left alone', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    await expect(archiveStudioDataset(7)).resolves.toMatchObject({ outcome: 'skipped' });
    expect(swaps()).toHaveLength(0);
  });
});
