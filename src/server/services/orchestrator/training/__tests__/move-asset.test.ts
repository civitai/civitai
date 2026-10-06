import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import type { Workflow } from '@civitai/client';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { moveAsset } from '~/server/services/orchestrator/training/move-asset';

const OWNER = 5;
const STRANGER = 6;
const MODERATOR = 999;
const VERSION_ID = 321;
const WORKFLOW_ID = '5-20261001000000000';

// The workflow's own URLs carry a different signature from the ones a client sends, so a test can
// tell which of the two was fetched.
const blobUrl = (blobId: string, sig = 'client') =>
  `https://orchestration.civitai.com/v2/consumer/blobs/${blobId}.safetensors?sig=${sig}&exp=2099-01-01`;
const runUrl = (blobId: string) => blobUrl(blobId, 'run');
const EPOCH_1 = 'EPOCHONE';
const EPOCH_2 = 'EPOCHTWO';
const SAMPLE = 'SAMPLEIMG';
const UNFINISHED = 'NOTREADY';
const OTHER_STEP = 'OTHERSTEP';

const mockFindUnique = dbMock.dbWrite.modelVersion.findUnique;
const mockQueryRaw = dbMock.dbWrite.$queryRaw;

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
      { epochNumber: 1, model: { id: `${EPOCH_1}.safetensors`, url: runUrl(EPOCH_1) } },
      {
        epochNumber: 2,
        model: { id: `${EPOCH_2}.safetensors`, url: runUrl(EPOCH_2), available: true },
        samples: [{ id: `${SAMPLE}.safetensors`, url: runUrl(SAMPLE) }],
      },
      {
        epochNumber: 3,
        model: { id: `${UNFINISHED}.safetensors`, url: runUrl(UNFINISHED), available: false },
      },
    ],
  };
  return {
    id: WORKFLOW_ID,
    steps: [
      {
        $type: 'training',
        output: moderationStatus === undefined ? output : { ...output, moderationStatus },
      },
      // A second epoch-bearing step: its blobs are not checkpoints of the training step.
      {
        $type: 'imageResourceTraining',
        output: {
          moderationStatus: 'approved',
          epochs: [{ epochNumber: 1, blobUrl: runUrl(OTHER_STEP) }],
        },
      },
    ],
  } as unknown as Workflow;
}

function legacyRun(moderationStatus: string | undefined): Workflow {
  const output = {
    sampleImagesPrompts: [],
    epochs: [{ epochNumber: 1, blobUrl: runUrl(EPOCH_1) }],
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

const jobUrl = (jobId: string, asset: string) =>
  `https://orchestration.civitai.com/v1/consumer/jobs/${jobId}/assets/${asset}`;
const JOB = '0a1b2c3d-0000-4000-8000-00000000000a';
const RESUBMITTED_JOB = '0a1b2c3d-0000-4000-8000-00000000000b';
const UNRECORDED_JOB = '0a1b2c3d-0000-4000-8000-00000000000c';
const JOB_ASSET = 'run_000001.safetensors';
const JOB_URL = jobUrl(JOB, JOB_ASSET);
const NOT_RECORDED = /not one of this model version's training outputs/;

/** Stored results of a legacy (pre-workflow) run, as its submit and webhook recorded them. */
const legacyResults = {
  jobId: JOB,
  history: [
    { time: '2024-01-01T00:00:00.000Z', status: 'Submitted', jobId: RESUBMITTED_JOB },
    { time: '2024-01-02T00:00:00.000Z', status: 'Submitted', jobId: JOB },
  ],
  epochs: [
    { epoch_number: 1, model_url: JOB_URL },
    { epoch_number: 2, model_url: jobUrl(RESUBMITTED_JOB, 'earlier_000002.safetensors') },
    { epoch_number: 3, model_url: jobUrl(UNRECORDED_JOB, 'stray_000003.safetensors') },
  ],
};

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
  fetchMock.mockImplementation(
    async () => new Response('weights', { status: 200, headers: { 'content-length': '7' } })
  );
  mockUploadDone.mockResolvedValue(undefined);
  mockQueryRaw.mockResolvedValue([
    {
      metadata: { trainingResults: { submittedAt: '2024-01-01T00:00:00.000Z' } },
      updatedAt: new Date(),
    },
  ] as never);
  mockCopyAsset.mockResolvedValue({
    ok: true,
    status: 200,
    data: { jobs: [{ lastEvent: { type: 'Succeeded' }, result: { found: true, fileSize: 9 } }] },
  });
});

describe('training.moveAsset — approved checkpoint of an owned run', () => {
  it('copies the run’s own URL for an approved epoch checkpoint of the version owner’s run', async () => {
    await expect(move()).resolves.toEqual({
      newUrl: `https://storage.example/modelVersion/${VERSION_ID}/${EPOCH_2}.safetensors`,
      fileSize: 7,
    });
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: VERSION_ID },
      select: {
        meta: true,
        model: { select: { userId: true } },
        files: { where: { type: 'Training Data' }, select: { metadata: true } },
      },
    });
    expect(mockGetToken).toHaveBeenCalledWith(OWNER, undefined, { bypassCache: false });
    expect(mockGetWorkflow).toHaveBeenCalledWith({
      token: 'owner-token',
      path: { workflowId: WORKFLOW_ID },
    });
    expect(fetchMock.mock.calls).toEqual([[runUrl(EPOCH_2)]]);
    expect(mockUploadDone).toHaveBeenCalledTimes(1);
  });

  it('copies an approved checkpoint of a legacy imageResourceTraining run', async () => {
    mockGetWorkflow.mockResolvedValue(legacyRun('approved'));
    await expect(move({ url: blobUrl(EPOCH_1) })).resolves.toMatchObject({ fileSize: 7 });
    expect(fetchMock.mock.calls).toEqual([[runUrl(EPOCH_1)]]);
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

  it('prefers the training file’s recorded run over the version meta', async () => {
    mockFindUnique.mockResolvedValue(
      dbVersion({ meta: { trainingWorkflowId: 'some-other-run' } }) as never
    );
    await move();
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
});

describe('training.moveAsset — legacy job-asset URL', () => {
  it('refuses a non-owner before any copy is requested', async () => {
    await expect(move({ url: JOB_URL, userId: STRANGER })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockQueryRaw).not.toHaveBeenCalled();
    expectNothingCopied();
  });

  describe('with the version’s recorded legacy run', () => {
    beforeEach(() => {
      mockFindUnique.mockResolvedValue(dbVersion({ trainingResults: legacyResults }) as never);
    });

    const copiedJob = () =>
      (mockCopyAsset.mock.calls[0][0] as { payload: { jobId: string; assetName: string } }).payload;

    it.each([
      ['the owner', OWNER, false],
      ['a moderator', MODERATOR, true],
    ])('lets %s copy, looking the run up under the version OWNER', async (_label, userId, mod) => {
      await expect(move({ url: JOB_URL, userId, isModerator: mod })).resolves.toMatchObject({
        fileSize: 9,
      });
      expect(mockCopyAsset).toHaveBeenCalledTimes(1);
      expect(copiedJob()).toMatchObject({ jobId: JOB, assetName: JOB_ASSET });
      const [, ...values] = mockQueryRaw.mock.calls[0] as unknown[];
      expect(values).toEqual([VERSION_ID, OWNER]);
    });

    it('copies the RECORDED job id, not the requested spelling of it', async () => {
      await move({ url: jobUrl(JOB.toUpperCase(), JOB_ASSET) });
      expect(copiedJob()).toMatchObject({ jobId: JOB, assetName: JOB_ASSET });
    });

    it('accepts an output of a job recorded only in the run history', async () => {
      await move({ url: jobUrl(RESUBMITTED_JOB, 'earlier_000002.safetensors') });
      expect(copiedJob()).toMatchObject({
        jobId: RESUBMITTED_JOB,
        assetName: 'earlier_000002.safetensors',
      });
    });

    it.each([
      ['a job the version does not record', jobUrl(UNRECORDED_JOB, JOB_ASSET)],
      ['an asset name the recorded job did not output', jobUrl(JOB, 'other_000009.safetensors')],
      [
        'a recorded output whose job is not one the version submitted',
        jobUrl(UNRECORDED_JOB, 'stray_000003.safetensors'),
      ],
    ])('refuses %s', async (_label, url) => {
      await expect(move({ url })).rejects.toThrow(NOT_RECORDED);
      expectNothingCopied();
    });
  });

  it('refuses a job asset for a version that records no legacy training job', async () => {
    await expect(move({ url: JOB_URL })).rejects.toThrow(/no recorded training job/);
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

  it.each([
    ['has no steps', { id: WORKFLOW_ID, steps: [] }],
    ['has only an unrelated step', { id: WORKFLOW_ID, steps: [{ $type: 'textToImage' }] }],
    ['has a training step with no output', { id: WORKFLOW_ID, steps: [{ $type: 'training' }] }],
  ])('refuses a run that %s', async (_label, workflow) => {
    mockGetWorkflow.mockResolvedValue(workflow);
    await expect(move()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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

  it('refuses a moderator too when the run is not approved', async () => {
    mockGetWorkflow.mockResolvedValue(trainingRun('rejected'));
    await expect(move({ userId: MODERATOR, isModerator: true })).rejects.toThrow(NOT_APPROVED);
    expectNothingCopied();
  });

  it('refuses a moderator too when the blob is not a checkpoint of the run', async () => {
    await expect(
      move({ url: blobUrl('SOMEOTHERBLOB'), userId: MODERATOR, isModerator: true })
    ).rejects.toThrow(NOT_A_CHECKPOINT);
    expectNothingCopied();
  });

  it.each([
    ['a blob from no epoch of the run', blobUrl('SOMEOTHERBLOB')],
    ['a sample image of the run', blobUrl(SAMPLE)],
    ['an epoch checkpoint that is not finished', blobUrl(UNFINISHED)],
    ['a blob from another step of the run', blobUrl(OTHER_STEP)],
  ])('refuses %s', async (_label, url) => {
    await expect(move({ url })).rejects.toThrow(NOT_A_CHECKPOINT);
    expectNothingCopied();
  });

  it('never fetches the requested URL — only the run’s own URL for the checkpoint it names', async () => {
    const requested = blobUrl(EPOCH_2).replace('orchestration.civitai.com', 'blobs.example.com');
    await expect(move({ url: requested })).resolves.toMatchObject({ fileSize: 7 });
    expect(fetchMock.mock.calls).toEqual([[runUrl(EPOCH_2)]]);
  });

  it('refuses a checkpoint whose run URL is on an untrusted host', async () => {
    const untrusted = 'https://blobs.example.com/v2/consumer/blobs/EPOCHTWO.safetensors?sig=run';
    mockGetWorkflow.mockResolvedValue({
      id: WORKFLOW_ID,
      steps: [
        {
          $type: 'training',
          output: {
            moderationStatus: 'approved',
            epochs: [{ epochNumber: 1, model: { id: `${EPOCH_2}.safetensors`, url: untrusted } }],
          },
        },
      ],
    });
    await expect(move()).rejects.toThrow('Invalid asset URL');
    expectNothingCopied();
  });
});
