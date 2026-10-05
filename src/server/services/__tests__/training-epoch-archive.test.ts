import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlobArchiveModule from '~/server/services/orchestrator/blobArchive';
import type * as OrchestratorToken from '~/server/orchestrator/get-orchestrator-token';
import type * as Workflows from '~/server/services/orchestrator/workflows';

/**
 * "Download All" on the training epoch view now asks the orchestrator to bundle every
 * blob a run produced into one zip, instead of streaming each epoch model through us.
 * What matters is the manifest we hand the orchestrator: which blobs, in what order,
 * and what happens to the ones we cannot resolve.
 */

const findFirst = dbMock.dbWrite.modelVersion.findFirst;
const ctx = { req: {}, res: {} } as never;

const getWorkflow = vi.fn();
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: (...args: unknown[]) => getWorkflow(...args),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorToken>()),
  getOrchestratorToken: async () => 'token',
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));

const createBlobArchive = vi.fn();
vi.mock('~/server/services/orchestrator/blobArchive', async (importOriginal) => ({
  ...(await importOriginal<typeof BlobArchiveModule>()),
  createBlobArchive: (...args: unknown[]) => createBlobArchive(...args),
}));

const { buildEpochArchiveEntries, getTrainingEpochArchive } = await import(
  '~/server/services/orchestrator/training/epoch-archive'
);

const blobUrl = (id: string) =>
  `https://orchestration.civitai.com/v2/consumer/blobs/${id}?sig=abc&exp=2030-01-01T00:00:00Z`;

const v2Results = {
  version: 2 as const,
  submittedAt: '2026-08-01T00:00:00Z',
  workflowId: 'wf-1',
  transactionData: [],
  history: [],
  sampleImagesPrompts: ['a', 'b'],
  epochs: [
    {
      epochNumber: 2,
      modelUrl: blobUrl('MODEL2.safetensors'),
      modelSize: 10,
      sampleImages: [blobUrl('E2S1.jpeg'), blobUrl('E2S2.mp4')],
    },
    {
      epochNumber: 1,
      modelUrl: blobUrl('MODEL1.safetensors'),
      modelSize: 10,
      sampleImages: [blobUrl('E1S1.jpeg')],
    },
  ],
};

describe('buildEpochArchiveEntries', () => {
  it('includes every epoch model AND every sample, models first, ascending by epoch', () => {
    const { entries, unresolvedCount, cappedCount } = buildEpochArchiveEntries({
      trainingResults: v2Results,
      modelName: 'My Cool Model!',
      versionName: 'V1',
      versionId: 77,
    });

    expect(unresolvedCount).toBe(0);
    expect(cappedCount).toBe(0);
    expect(entries).toEqual([
      { blobId: 'MODEL1.safetensors', fileName: 'My_Cool_Model__77_epoch_1.safetensors' },
      { blobId: 'MODEL2.safetensors', fileName: 'My_Cool_Model__77_epoch_2.safetensors' },
      { blobId: 'E1S1.jpeg', fileName: 'My_Cool_Model__77_epoch_1_sample_1.jpeg' },
      { blobId: 'E2S1.jpeg', fileName: 'My_Cool_Model__77_epoch_2_sample_1.jpeg' },
      { blobId: 'E2S2.mp4', fileName: 'My_Cool_Model__77_epoch_2_sample_2.mp4' },
    ]);
  });

  it("skips a failed sample's empty slot without counting it unresolved, keeping later sample numbers", () => {
    const { entries, unresolvedCount } = buildEpochArchiveEntries({
      trainingResults: {
        ...v2Results,
        epochs: [{ ...v2Results.epochs[1], sampleImages: ['', blobUrl('E1S2.jpeg')] }],
      },
      modelName: 'M',
      versionName: 'V1',
      versionId: 77,
    });

    expect(unresolvedCount).toBe(0);
    expect(entries.map((e) => e.fileName)).toEqual([
      'M_77_epoch_1.safetensors',
      'M_77_epoch_1_sample_2.jpeg',
    ]);
  });

  it('normalizes the legacy v1 epoch shape', () => {
    const { entries } = buildEpochArchiveEntries({
      trainingResults: {
        start_time: null,
        end_time: null,
        attempts: null,
        jobId: null,
        transactionId: null,
        history: null,
        epochs: [
          {
            epoch_number: 1,
            model_url: blobUrl('LEGACY.safetensors'),
            sample_images: [{ image_url: blobUrl('LEGACYS1.jpeg'), prompt: 'a' }],
          },
        ],
      },
      modelName: 'legacy',
      versionName: 'V1',
      versionId: 77,
    });

    expect(entries).toEqual([
      { blobId: 'LEGACY.safetensors', fileName: 'legacy_77_epoch_1.safetensors' },
      { blobId: 'LEGACYS1.jpeg', fileName: 'legacy_77_epoch_1_sample_1.jpeg' },
    ]);
  });

  it('counts URLs that are not orchestrator blobs as unresolved rather than dropping them silently', () => {
    const { entries, unresolvedCount, cappedCount } = buildEpochArchiveEntries({
      trainingResults: {
        ...v2Results,
        epochs: [
          {
            epochNumber: 1,
            modelUrl: 'https://s3.example.com/jobs/abc/assets/old.safetensors',
            modelSize: 0,
            sampleImages: [blobUrl('OK.jpeg'), ''],
          },
        ],
      },
      modelName: 'legacy',
      versionName: 'V1',
      versionId: 77,
    });

    expect(entries).toEqual([{ blobId: 'OK.jpeg', fileName: 'legacy_77_epoch_1_sample_1.jpeg' }]);
    // The non-blob model URL; the '' sample slot isn't counted.
    expect(unresolvedCount).toBe(1);
    expect(cappedCount).toBe(0);
  });

  it('keeps the model files and reports the overflow when a run exceeds the entry cap', () => {
    const { entries, unresolvedCount, cappedCount } = buildEpochArchiveEntries({
      trainingResults: v2Results,
      modelName: 'capped',
      versionName: 'V1',
      versionId: 77,
      maxEntries: 3,
    });

    expect(entries.map((e) => e.blobId)).toEqual([
      'MODEL1.safetensors',
      'MODEL2.safetensors',
      'E1S1.jpeg',
    ]);
    expect(cappedCount).toBe(2);
    expect(unresolvedCount).toBe(0);
  });
});

describe('getTrainingEpochArchive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Past retention by default, so the stored copy is what gets archived.
    getWorkflow.mockRejectedValue(new Error('not found'));
    createBlobArchive.mockResolvedValue({
      url: 'https://orchestration.civitai.com/v2/consumer/blobs/archive/token',
      entryCount: 5,
      format: 'zip',
      expiresAt: '2030-01-01T00:00:00Z',
    });
  });

  const modelVersion = {
    id: 1,
    trainingStatus: 'InReview',
    trainingDetails: { baseModel: 'pony' },
    meta: null,
    model: { userId: 10, name: 'My Cool Model!' },
    files: [{ id: 5, type: 'Training Data', metadata: { trainingResults: v2Results } }],
  };

  // The architecture segment reaches the filename only through `trainingDetails` in this select;
  // dropping it from the select is the regression this pins.
  it('archives every blob for the owner, named by architecture', async () => {
    findFirst.mockResolvedValue(modelVersion);

    const result = await getTrainingEpochArchive({ modelVersionId: 1, userId: 10, ctx });

    expect(createBlobArchive).toHaveBeenCalledWith({
      entries: expect.arrayContaining([
        {
          blobId: 'MODEL1.safetensors',
          fileName: 'My_Cool_Model__pony_1_epoch_1.safetensors',
        },
        {
          blobId: 'E2S2.mp4',
          fileName: 'My_Cool_Model__pony_1_epoch_2_sample_2.mp4',
        },
      ]),
      archiveName: 'My_Cool_Model__pony_1_training.zip',
    });
    expect(createBlobArchive.mock.calls[0][0].entries).toHaveLength(5);
    expect(result.url).toContain('/archive/token');
    expect(result.unresolvedCount).toBe(0);
    expect(result.cappedCount).toBe(0);
  });

  // The epoch screen lists the live workflow's epochs; a stored copy that lags it must not shrink
  // the archive to what had been written back so far.
  it('archives the epochs the live workflow has, not a stored copy that is behind it', async () => {
    findFirst.mockResolvedValue(modelVersion);
    getWorkflow.mockResolvedValue({
      id: 'wf-1',
      status: 'succeeded',
      steps: [
        {
          $type: 'imageResourceTraining',
          metadata: { modelFileId: 5 },
          output: {
            epochs: [1, 2, 3].map((n) => ({
              epochNumber: n,
              blobUrl: blobUrl(`MODEL${n}.safetensors`),
              sampleImages: [],
            })),
          },
        },
      ],
    });

    await getTrainingEpochArchive({ modelVersionId: 1, userId: 10, ctx });

    expect(createBlobArchive.mock.calls[0][0].entries).toContainEqual({
      blobId: 'MODEL3.safetensors',
      fileName: 'My_Cool_Model__pony_1_epoch_3.safetensors',
    });
  });

  it('refuses a user who does not own the model', async () => {
    findFirst.mockResolvedValue(modelVersion);

    await expect(
      getTrainingEpochArchive({ modelVersionId: 1, userId: 99, ctx })
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(createBlobArchive).not.toHaveBeenCalled();
  });

  it('allows a moderator', async () => {
    findFirst.mockResolvedValue(modelVersion);

    await expect(
      getTrainingEpochArchive({ modelVersionId: 1, userId: 99, isModerator: true, ctx })
    ).resolves.toMatchObject({ entryCount: 5 });
  });

  it('fails loudly rather than requesting an empty archive when no blob survives', async () => {
    findFirst.mockResolvedValue({
      ...modelVersion,
      files: [
        {
          id: 5,
          type: 'Training Data',
          metadata: {
            trainingResults: {
              ...v2Results,
              epochs: [
                {
                  epochNumber: 1,
                  modelUrl: 'https://s3.example.com/jobs/abc/assets/old.safetensors',
                  modelSize: 0,
                  sampleImages: [],
                },
              ],
            },
          },
        },
      ],
    });

    await expect(
      getTrainingEpochArchive({ modelVersionId: 1, userId: 10, ctx })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(createBlobArchive).not.toHaveBeenCalled();
  });
});
