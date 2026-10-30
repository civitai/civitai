import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModelFileService from '~/server/services/model-file.service';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';

/**
 * `isModerator` is what lets `createFile` attach to a version the caller does not own. The transfer
 * job passes it as a plain `true`, so the tRPC path must keep passing the session's own value —
 * these pin that the two callers are not interchangeable.
 */
const { createFile, updateFile, registerFileLocation, createModelFileScanRequest } = vi.hoisted(
  () => ({
    createFile: vi.fn(),
    updateFile: vi.fn(),
    registerFileLocation: vi.fn(),
    createModelFileScanRequest: vi.fn(),
  })
);

vi.mock('~/server/services/model-file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelFileService>()),
  createFile,
  updateFile,
}));
vi.mock('~/utils/storage-resolver', () => ({ registerFileLocation }));
vi.mock('~/server/services/model-file-scan.service', () => ({
  createModelFileScanRequest,
  ModelFileScanSubmissionError: class extends Error {},
}));

import {
  createFileHandler,
  createModelFile,
  updateFileHandler,
} from '~/server/controllers/model-file.controller';

const input = {
  modelVersionId: 42,
  type: 'Model' as const,
  name: 'flux.safetensors',
  url: 'https://model-bucket.r2.example.com/model/7/flux.safetensors',
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
  url: 'https://model-bucket.r2.example.com/training-images/7/dataset.zip',
  sizeKB: 2,
  metadata: { uploadDomain: 'red' as const, numImages: 12 },
};

const track = { modelFile: vi.fn().mockResolvedValue(undefined) };

beforeEach(() => {
  vi.clearAllMocks();
  // The fixtures are user 7's own uploads in these buckets, so the client url bound lets them through.
  envMock.set({
    S3_UPLOAD_ENDPOINT: 'https://r2.example.com',
    S3_UPLOAD_BUCKET: 'model-bucket',
    S3_UPLOAD_B2_BUCKET: 'model-bucket',
  });
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

// Downloads resolve a file id through storage-resolver first, and the scan reads the record's url, so
// the registered location must be the url's own key whatever path the request names.
describe('the storage location registered for a new file', () => {
  const CLIENT_PATH = 'someone-else/other.safetensors';

  it.each([
    {
      store: 'B2',
      backend: 'b2',
      url: 'https://s3.us-west-004.backblazeb2.com/model-bucket/model/7/flux.safetensors',
      registered: { backend: 'backblaze', path: 'model/7/flux.safetensors' },
    },
    {
      store: 'R2',
      backend: undefined,
      url: 'https://model-bucket.r2.example.com/model/7/flux.safetensors',
      registered: { backend: 'cloudflare', path: 'model/7/flux.safetensors' },
    },
  ])(
    'registers the key in the url on a $store upload, not a client-supplied path',
    async ({ backend, url, registered }) => {
      await createFileHandler({
        input: { ...input, url, backend, s3Path: CLIENT_PATH },
        ctx: { user: { id: 7, isModerator: false }, track, domain: 'green' } as never,
      });

      expect(registerFileLocation).toHaveBeenCalledTimes(1);
      expect(registerFileLocation).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 900, ...registered })
      );
    }
  );

  // The Hugging Face transfer builds its key server-side from the bucket it wrote to.
  it('still registers the key a server-side caller passes', async () => {
    await createModelFile({
      input: {
        ...input,
        url: 'https://s3.us-west-004.backblazeb2.com/model-bucket/model/7/flux.safetensors',
        backend: 'b2',
        s3Path: 'imports/7/flux.safetensors',
      },
      userId: -1,
      isModerator: true,
      track: track as never,
      uploadDomain: null,
    });

    expect(registerFileLocation).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'backblaze', path: 'imports/7/flux.safetensors' })
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

describe('training results in the metadata a client sends', () => {
  const trainingResults = {
    version: 2,
    epochs: [
      {
        epochNumber: 1,
        modelUrl: 'https://example.com/m',
        sampleImages: ['https://example.com/a.jpeg'],
      },
    ],
  };

  it.each([input, trainingInput])('are dropped on create ($type), the rest kept', async (base) => {
    await createFileHandler({
      input: { ...base, metadata: { numImages: 3, trainingResults } } as never,
      ctx: { user: { id: 7, isModerator: false }, track, domain: 'green' } as never,
    });

    const [{ metadata }] = createFile.mock.calls[0];
    expect(metadata).not.toHaveProperty('trainingResults');
    expect(metadata.numImages).toBe(3);
  });

  it('are dropped on update, the rest kept', async () => {
    updateFile.mockResolvedValue({
      id: 900,
      replacedFileId: undefined,
      modelVersion: { modelId: 5 },
    });

    await updateFileHandler({
      input: {
        id: 900,
        metadata: { selectedEpochUrl: 'https://example.com/m', trainingResults },
      } as never,
      ctx: { user: { id: 7, isModerator: false }, track, domain: 'green' } as never,
    }).catch(() => null);

    const [{ metadata }] = updateFile.mock.calls[0];
    expect(metadata).not.toHaveProperty('trainingResults');
    expect(metadata.selectedEpochUrl).toBe('https://example.com/m');
  });
});

describe('the url a client may give a new file', () => {
  const theirs = 'https://model-bucket.r2.example.com/model/8/theirs.safetensors';

  it('refuses a url under another user upload prefix, before anything is created', async () => {
    await expect(
      createFileHandler({
        input: { ...input, url: theirs },
        ctx: { user: { id: 7, isModerator: false }, track, domain: 'green' } as never,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(createFile).not.toHaveBeenCalled();
  });

  it('lets a moderator use it', async () => {
    await createFileHandler({
      input: { ...input, url: theirs },
      ctx: { user: { id: 99, isModerator: true }, track, domain: 'green' } as never,
    });
    expect(createFile).toHaveBeenCalledWith(expect.objectContaining({ url: theirs }));
  });

  // The Hugging Face transfer job names the object it wrote itself.
  it('does not check a server-side create', async () => {
    await createModelFile({
      input: { ...input, url: theirs },
      userId: 7,
      isModerator: false,
      track: track as never,
      uploadDomain: null,
    });
    expect(createFile).toHaveBeenCalledWith(expect.objectContaining({ url: theirs }));
  });
});
