import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlobArchiveModule from '~/server/services/orchestrator/blobArchive';

/**
 * "Download All" on the training epoch view now asks the orchestrator to bundle every
 * blob a run produced into one zip, instead of streaming each epoch model through us.
 * What matters is the manifest we hand the orchestrator: which blobs, in what order,
 * and what happens to the ones we cannot resolve.
 */

const findUnique = dbMock.dbRead.modelVersion.findUnique;
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
    expect(unresolvedCount).toBe(2);
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
    createBlobArchive.mockResolvedValue({
      url: 'https://orchestration.civitai.com/v2/consumer/blobs/archive/token',
      entryCount: 5,
      format: 'zip',
      expiresAt: '2030-01-01T00:00:00Z',
    });
  });

  const modelVersion = {
    id: 1,
    trainingDetails: { baseModel: 'pony' },
    model: { userId: 10, name: 'My Cool Model!' },
    files: [{ metadata: { trainingResults: v2Results } }],
  };

  // The architecture segment reaches the filename only through `trainingDetails` in this select;
  // dropping it from the select is the regression this pins.
  it('archives every blob for the owner, named by architecture', async () => {
    findUnique.mockResolvedValue(modelVersion);

    const result = await getTrainingEpochArchive({ modelVersionId: 1, userId: 10 });

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

  it('refuses a user who does not own the model', async () => {
    findUnique.mockResolvedValue(modelVersion);

    await expect(getTrainingEpochArchive({ modelVersionId: 1, userId: 99 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(createBlobArchive).not.toHaveBeenCalled();
  });

  it('allows a moderator', async () => {
    findUnique.mockResolvedValue(modelVersion);

    await expect(
      getTrainingEpochArchive({ modelVersionId: 1, userId: 99, isModerator: true })
    ).resolves.toMatchObject({ entryCount: 5 });
  });

  it('fails loudly rather than requesting an empty archive when no blob survives', async () => {
    findUnique.mockResolvedValue({
      ...modelVersion,
      files: [
        {
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

    await expect(getTrainingEpochArchive({ modelVersionId: 1, userId: 10 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(createBlobArchive).not.toHaveBeenCalled();
  });
});
