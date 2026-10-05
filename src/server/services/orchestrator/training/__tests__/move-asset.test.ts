import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import type * as OrchestratorToken from '~/server/orchestrator/get-orchestrator-token';
import type * as Workflows from '~/server/services/orchestrator/workflows';
import type * as S3Utils from '~/utils/s3-utils';

/**
 * `training.moveAsset` copies a training checkpoint into storage under the target model version.
 * Only the storage write, the download and the orchestrator read are faked; the version lookup, the
 * ownership check and the source-run check run for real.
 */

const { mockGetWorkflow, mockGetToken, mockGetPutUrl, mockUploadDone, mockCopyAsset } = vi.hoisted(
  () => ({
    mockGetWorkflow: vi.fn(),
    mockGetToken: vi.fn(),
    mockGetPutUrl: vi.fn(),
    mockUploadDone: vi.fn(),
    mockCopyAsset: vi.fn(),
  })
);

vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: mockGetWorkflow,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorToken>()),
  getOrchestratorToken: mockGetToken,
}));
// `default` alongside the named export: pre-bundling wraps this CJS dep for interop.
vi.mock('@aws-sdk/lib-storage', () => {
  const Upload = class {
    done = mockUploadDone;
  };
  return { Upload, default: { Upload } };
});
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getPutUrl: mockGetPutUrl,
  getS3Client: vi.fn(),
}));
vi.mock('~/server/http/orchestrator/orchestrator.caller', () => ({
  getOrchestratorCaller: () => ({ copyAsset: mockCopyAsset }),
}));
// The real module pulls client-only code into the node graph; moveAsset reads nothing from it.
vi.mock('~/server/schema/training.schema', () => ({
  trainingServiceStatusSchema: z.object({}),
}));

import type { Workflow } from '@civitai/client';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { moveAsset } from '~/server/services/orchestrator/training/move-asset';

const OWNER = 5;
const STRANGER = 6;
const MODERATOR = 999;
const VERSION_ID = 321;
const WORKFLOW_ID = '5-20261001000000000';

const blobUrl = (blobId: string) =>
  `https://orchestration.civitai.com/v2/consumer/blobs/${blobId}.safetensors?sig=s&exp=2099-01-01`;
const EPOCH_1 = 'EPOCHONE';
const EPOCH_2 = 'EPOCHTWO';
const SAMPLE = 'SAMPLEIMG';
const UNFINISHED = 'NOTREADY';

const mockFindUnique = dbMock.dbWrite.modelVersion.findUnique;

function dbVersion({
  ownerId = OWNER,
  trainingResults = { version: 2, workflowId: WORKFLOW_ID } as unknown,
  meta = null as unknown,
} = {}) {
  return {
    meta,
    model: { userId: ownerId },
    files: [{ metadata: trainingResults ? { trainingResults } : {} }],
  };
}

function trainingRun(moderationStatus: string | undefined): Workflow {
  const output = {
    epochs: [
      { epochNumber: 1, model: { id: `${EPOCH_1}.safetensors`, url: blobUrl(EPOCH_1) } },
      {
        epochNumber: 2,
        model: { id: `${EPOCH_2}.safetensors`, url: blobUrl(EPOCH_2), available: true },
        samples: [{ id: `${SAMPLE}.safetensors`, url: blobUrl(SAMPLE) }],
      },
      { epochNumber: 3, model: { id: `${UNFINISHED}.safetensors`, available: false } },
    ],
  };
  return {
    id: WORKFLOW_ID,
    steps: [
      {
        $type: 'training',
        output: moderationStatus === undefined ? output : { ...output, moderationStatus },
      },
    ],
  } as unknown as Workflow;
}

function legacyRun(moderationStatus: string | undefined): Workflow {
  const output = {
    sampleImagesPrompts: [],
    epochs: [{ epochNumber: 1, blobUrl: blobUrl(EPOCH_1) }],
  };
  return {
    id: WORKFLOW_ID,
    steps: [
      {
        $type: 'imageResourceTraining',
        output: moderationStatus === undefined ? output : { ...output, moderationStatus },
      },
    ],
  } as unknown as Workflow;
}

const move = ({
  url = blobUrl(EPOCH_2),
  userId = OWNER,
  isModerator = false,
}: { url?: string; userId?: number; isModerator?: boolean } = {}) =>
  moveAsset({ url, modelVersionId: VERSION_ID, userId, isModerator });

const NOT_APPROVED = /dataset has not been approved/;
const NOT_A_CHECKPOINT = /not a checkpoint from this training run/;
const RUN_UNAVAILABLE = /training run could not be found/;

const fetchMock = vi.fn();

function expectNothingCopied() {
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mockGetPutUrl).not.toHaveBeenCalled();
  expect(mockUploadDone).not.toHaveBeenCalled();
  expect(mockCopyAsset).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  mockFindUnique.mockResolvedValue(dbVersion() as never);
  mockGetToken.mockResolvedValue('owner-token');
  mockGetWorkflow.mockResolvedValue(trainingRun('approved'));
  mockGetPutUrl.mockImplementation(async (key: string) => ({
    url: `https://storage.example/${key}?signed=1`,
    bucket: 'b',
    key,
  }));
  fetchMock.mockResolvedValue(
    new Response('weights', { status: 200, headers: { 'content-length': '7' } })
  );
  mockUploadDone.mockResolvedValue(undefined);
});

describe('training.moveAsset — approved checkpoint of an owned run', () => {
  it('copies an approved epoch checkpoint of the version owner’s run', async () => {
    await expect(move()).resolves.toEqual({
      newUrl: `https://storage.example/modelVersion/${VERSION_ID}/${EPOCH_2}.safetensors`,
      fileSize: 7,
    });
    expect(mockGetToken).toHaveBeenCalledWith(OWNER, undefined, { bypassCache: false });
    expect(mockGetWorkflow).toHaveBeenCalledWith({
      token: 'owner-token',
      path: { workflowId: WORKFLOW_ID },
    });
    expect(fetchMock).toHaveBeenCalledWith(blobUrl(EPOCH_2));
    expect(mockUploadDone).toHaveBeenCalledTimes(1);
  });

  it('copies an approved checkpoint of a legacy imageResourceTraining run', async () => {
    mockGetWorkflow.mockResolvedValue(legacyRun('approved'));
    await expect(move({ url: blobUrl(EPOCH_1) })).resolves.toMatchObject({ fileSize: 7 });
  });

  it('resolves the run from the version meta when the training file has no results', async () => {
    mockFindUnique.mockResolvedValue(
      dbVersion({ trainingResults: null, meta: { trainingWorkflowId: WORKFLOW_ID } }) as never
    );
    await expect(move()).resolves.toMatchObject({ fileSize: 7 });
    expect(mockGetWorkflow).toHaveBeenCalledWith({
      token: 'owner-token',
      path: { workflowId: WORKFLOW_ID },
    });
  });

  it('lets a moderator copy, reading the run with the OWNER token', async () => {
    await expect(move({ userId: MODERATOR, isModerator: true })).resolves.toMatchObject({
      fileSize: 7,
    });
    expect(mockGetToken.mock.calls).toEqual([[OWNER, undefined, { bypassCache: true }]]);
  });
});

describe('training.moveAsset — target version', () => {
  it('refuses a caller who does not own the model version', async () => {
    await expect(move({ userId: STRANGER })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockGetWorkflow).not.toHaveBeenCalled();
    expectNothingCopied();
  });

  it('refuses a model version that does not exist', async () => {
    mockFindUnique.mockResolvedValue(null as never);
    await expect(move()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expectNothingCopied();
  });

  it('refuses a non-owner on the legacy job-asset path before any copy is requested', async () => {
    const jobUrl =
      'https://orchestration.civitai.com/v1/consumer/jobs/0a1b2c3d-0000-4000-8000-000000000000/assets/x.safetensors';
    await expect(move({ url: jobUrl, userId: STRANGER })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expectNothingCopied();
  });
});

describe('training.moveAsset — source run', () => {
  it('refuses a run the version owner’s token cannot read (not theirs)', async () => {
    mockGetWorkflow.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND', message: 'nope' }));
    await expect(move()).rejects.toThrow(RUN_UNAVAILABLE);
    expectNothingCopied();
  });

  it('refuses when the orchestrator returns no workflow', async () => {
    mockGetWorkflow.mockResolvedValue(undefined);
    await expect(move()).rejects.toThrow(RUN_UNAVAILABLE);
    expectNothingCopied();
  });

  it('rethrows any other read failure without copying', async () => {
    mockGetWorkflow.mockRejectedValue(
      new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'orchestrator down' })
    );
    await expect(move()).rejects.toThrow('orchestrator down');
    expectNothingCopied();
  });

  it('refuses a version with no recorded training run, without reading any workflow', async () => {
    mockFindUnique.mockResolvedValue(dbVersion({ trainingResults: null }) as never);
    await expect(move()).rejects.toThrow(RUN_UNAVAILABLE);
    expect(mockGetWorkflow).not.toHaveBeenCalled();
    expectNothingCopied();
  });

  describe.each([
    ['training', trainingRun],
    ['imageResourceTraining', legacyRun],
  ] as const)('%s step', (_stepType, run) => {
    it.each(['evaluating', 'underReview', 'rejected', undefined])(
      'refuses a run whose moderation status is %s',
      async (status) => {
        mockGetWorkflow.mockResolvedValue(run(status));
        await expect(move({ url: blobUrl(EPOCH_1) })).rejects.toThrow(NOT_APPROVED);
        expectNothingCopied();
      }
    );
  });

  it('refuses a checkpoint of the run served from an untrusted host', async () => {
    const url = blobUrl(EPOCH_2).replace('orchestration.civitai.com', 'blobs.example.com');
    await expect(move({ url })).rejects.toThrow('Invalid asset URL');
    expectNothingCopied();
  });

  it.each([
    ['a blob from no epoch of the run', 'SOMEOTHERBLOB'],
    ['a sample image of the run', SAMPLE],
    ['an epoch checkpoint that is not finished', UNFINISHED],
  ])('refuses %s', async (_label, blobId) => {
    await expect(move({ url: blobUrl(blobId) })).rejects.toThrow(NOT_A_CHECKPOINT);
    expectNothingCopied();
  });
});
