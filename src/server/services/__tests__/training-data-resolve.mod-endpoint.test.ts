import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/** A Training Studio publish leaves a `Training Data` row whose URL is the trained model;
 *  resolving it would serve weights labelled as training data. */

const resolveDownloadUrl = vi.hoisted(() => vi.fn());
vi.mock('~/utils/delivery-worker', () => ({ resolveDownloadUrl }));
vi.mock('~/server/utils/moderator-endpoint', () => ({
  defineModeratorEndpoint: (_name: string, def: unknown) => def,
}));

type Handler = {
  handler: (input: { modelVersionId: number }, ctx: { actor: { id: number } }) => Promise<unknown>;
};
const findMany = dbMock.dbRead.modelFile.findMany;
const resolve = (await import('../../../pages/api/mod/training-data/resolve'))
  .default as unknown as Handler;
const actor = { actor: { id: 99 } };

const EPOCH_URL = 'https://orchestration.example/v2/consumer/blobs/epoch-5.safetensors';
const ZIP_URL = 's3://bucket/training/123.zip';
const onModel = (meta: Record<string, unknown>) => ({ modelVersion: { model: { meta } } });
const studioModel = onModel({ trainingStudioWorkflowId: 'wf-studio' });

const row = (fields: Record<string, unknown>) => ({
  id: 1,
  name: 'v_training_data.zip',
  ...fields,
});

beforeEach(() => {
  findMany.mockReset();
  resolveDownloadUrl.mockReset();
  resolveDownloadUrl.mockResolvedValue({ url: 'https://signed/url' });
});

describe('trainingData.resolve', () => {
  it('refuses the Training Studio row, whose URL is the selected epoch, and signs nothing', async () => {
    findMany.mockResolvedValue([
      row({
        url: EPOCH_URL,
        metadata: { selectedEpochUrl: EPOCH_URL, trainingResults: { workflowId: 'wf-studio' } },
        ...studioModel,
      }),
    ]);

    await expect(resolve.handler({ modelVersionId: 3407557 }, actor)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('Training Studio'),
    });
    expect(resolveDownloadUrl).not.toHaveBeenCalled();
  });

  it('still refuses that row when its file metadata no longer names the epoch', async () => {
    findMany.mockResolvedValue([
      row({
        url: EPOCH_URL,
        metadata: { trainingResults: { workflowId: 'wf-studio' } },
        ...studioModel,
      }),
    ]);

    await expect(resolve.handler({ modelVersionId: 3407557 }, actor)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(resolveDownloadUrl).not.toHaveBeenCalled();
  });

  it('resolves a zip on a model that never came from the Training Studio, whatever its metadata says', async () => {
    // The owner can write `selectedEpochUrl`; only the server-owned model meta marks a studio run.
    findMany.mockResolvedValue([
      row({ url: ZIP_URL, metadata: { selectedEpochUrl: ZIP_URL }, ...onModel({}) }),
    ]);

    await expect(resolve.handler({ modelVersionId: 123 }, actor)).resolves.toMatchObject({
      url: 'https://signed/url',
    });
    expect(resolveDownloadUrl).toHaveBeenCalledWith(
      1,
      ZIP_URL,
      'v_training_data.zip',
      expect.anything()
    );
  });

  it('resolves an ordinary zip run on another version of a Training Studio model', async () => {
    findMany.mockResolvedValue([
      row({
        url: ZIP_URL,
        metadata: { selectedEpochUrl: EPOCH_URL, trainingResults: { workflowId: 'wf-zip-run' } },
        ...studioModel,
      }),
    ]);

    await expect(resolve.handler({ modelVersionId: 124 }, actor)).resolves.toMatchObject({
      url: 'https://signed/url',
    });
  });
});
