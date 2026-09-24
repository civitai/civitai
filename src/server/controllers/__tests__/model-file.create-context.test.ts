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

/**
 * A dataset upload that also carries a client-chosen `uploadDomain`. The two values are always
 * distinct in these tests so an implementation that reads the client's — or that hardcodes one
 * colour — cannot pass by coincidence.
 */
const trainingInput = {
  modelVersionId: 42,
  type: 'Training Data' as const,
  name: 'dataset.zip',
  url: 'https://s3.example/model-bucket/training/7/dataset.zip',
  sizeKB: 2,
  metadata: { uploadDomain: 'red' as const, numImages: 12 },
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
    await createModelFile({
      input,
      userId: -1,
      isModerator: true,
      track: track as never,
      uploadDomain: null,
    });

    expect(createFile).toHaveBeenCalledWith(
      expect.objectContaining({ userId: -1, isModerator: true })
    );
  });
});

/**
 * `uploadDomain` is what lets the paid training submit refuse an NSFW dataset prepared on red being
 * paid for on green (`createTrainingWorkflow` in training.orch.ts reads it off the 'Training Data'
 * file's metadata). It is therefore a payment/safety stamp, and the only value it may ever carry is
 * the server's own view of the request domain — `ctx.domain`. These pin that, not merely that
 * *something* gets written.
 */
describe('the uploadDomain stamp on a training-data upload', () => {
  // Server and client disagree in BOTH rows, and the server's value differs between rows, so
  // reading `input.metadata`, hardcoding a colour, or dropping the stamp all go red.
  it.each([
    { serverDomain: 'green', clientDomain: 'red' },
    { serverDomain: 'red', clientDomain: 'blue' },
  ] as const)(
    'stamps the server domain ($serverDomain), not the client-supplied one ($clientDomain)',
    async ({ serverDomain, clientDomain }) => {
      await createFileHandler({
        input: {
          ...trainingInput,
          metadata: { ...trainingInput.metadata, uploadDomain: clientDomain },
        },
        ctx: { user: { id: 7, isModerator: false }, track, domain: serverDomain } as never,
      });

      expect(createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ uploadDomain: serverDomain, numImages: 12 }),
        })
      );
    }
  );

  it('drops the client value when the caller has no request domain to stamp', async () => {
    await createModelFile({
      input: trainingInput,
      userId: -1,
      isModerator: true,
      track: track as never,
      uploadDomain: null,
    });

    const [{ metadata }] = createFile.mock.calls[0];
    expect(metadata.uploadDomain).toBeUndefined();
    // The rest of the client's metadata is untouched — only the stamp is server-owned.
    expect(metadata.numImages).toBe(12);
  });

  it('leaves a non-training upload alone', async () => {
    await createFileHandler({
      input,
      ctx: { user: { id: 7, isModerator: false }, track, domain: 'green' } as never,
    });

    const [{ metadata }] = createFile.mock.calls[0];
    expect(metadata?.uploadDomain).toBeUndefined();
  });
});
