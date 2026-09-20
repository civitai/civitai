import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModelFileService from '~/server/services/model-file.service';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/env.mock';

/**
 * `isModerator` is what lets `createFile` attach to a version the caller does not own. The transfer
 * job passes it as a plain `true`, so the tRPC path must keep passing the session's own value —
 * these pin that the two callers are not interchangeable.
 */
const { createFile, registerFileLocation, createModelFileScanRequest } = vi.hoisted(() => ({
  createFile: vi.fn(),
  registerFileLocation: vi.fn(),
  createModelFileScanRequest: vi.fn(),
}));

vi.mock('~/server/services/model-file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelFileService>()),
  createFile,
}));
vi.mock('~/utils/storage-resolver', () => ({ registerFileLocation }));
vi.mock('~/server/services/model-file-scan.service', () => ({
  createModelFileScanRequest,
  ModelFileScanSubmissionError: class extends Error {},
}));

import { createFileHandler, createModelFile } from '~/server/controllers/model-file.controller';

const input = {
  modelVersionId: 42,
  type: 'Model' as const,
  name: 'flux.safetensors',
  url: 'https://s3.example/model-bucket/model/7/flux.safetensors',
  sizeKB: 2,
};

const track = { modelFile: vi.fn().mockResolvedValue(undefined) };

beforeEach(() => {
  vi.clearAllMocks();
  createFile.mockResolvedValue({
    id: 900,
    name: 'flux.safetensors',
    modelVersion: {
      id: 42,
      modelId: 5,
      baseModel: 'Flux.1 D',
      status: 'Draft',
      model: { type: 'Checkpoint' },
      _count: { posts: 0 },
    },
  });
  createModelFileScanRequest.mockResolvedValue(undefined);
});

describe('the model-file create path', () => {
  it.each([true, false])(
    "carries the session's isModerator (%s) through the tRPC path",
    async (isModerator) => {
      await createFileHandler({
        input,
        ctx: { user: { id: 7, isModerator }, track } as never,
      });

      expect(createFile).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, isModerator }));
    }
  );

  it('lets a caller with no session state who it is acting as', async () => {
    await createModelFile({ input, userId: -1, isModerator: true, track: track as never });

    expect(createFile).toHaveBeenCalledWith(
      expect.objectContaining({ userId: -1, isModerator: true })
    );
  });
});
