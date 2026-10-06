import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `createDraftModelFromWorkflow` builds the Draft chain for a Training-Studio run. The
 * page-level ownership gate lives in `from-orchestrator.tsx` (the workflow is fetched with
 * the CALLER'S orchestrator token; a foreign workflow 404s). What this suite pins is the
 * service-side half of that posture: the idempotency lookup is scoped to the caller's
 * userId — without it, user B publishing the same workflowId would be handed user A's
 * existing draft model ids — plus the mapping/refusal behaviors the wizard depends on.
 */

const {
  mockUpsertModel,
  mockUpsertModelVersion,
  mockCreateFile,
  mockGetToken,
  mockGetWorkflow,
  mockUpdateWorkflow,
} = vi.hoisted(() => ({
  mockUpsertModel: vi.fn(),
  mockUpsertModelVersion: vi.fn(),
  mockCreateFile: vi.fn(),
  mockGetToken: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockUpdateWorkflow: vi.fn(),
}));

vi.mock('~/server/services/model.service', () => ({ upsertModel: mockUpsertModel }));
vi.mock('~/server/services/model-version.service', () => ({
  upsertModelVersion: mockUpsertModelVersion,
}));
vi.mock('~/server/services/model-file.service', () => ({ createFile: mockCreateFile }));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mockGetToken,
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  getWorkflow: mockGetWorkflow,
  updateWorkflow: mockUpdateWorkflow,
}));

import type { Workflow } from '@civitai/client';
import { TRPCError } from '@trpc/server';
import type { SessionUser } from '~/types/session';
import {
  assertTrainingSourcePublishable,
  createDraftModelFromWorkflow,
  isTrainingNotApprovedRefusal,
  mapTrainingBaseModelToBaseModel,
  mapWorkflowToTrainingResultsV2,
  stampWorkflowDraftModel,
  stampWorkflowPublished,
} from '~/server/services/orchestrator/training/publish-from-workflow';
import { trainingModelInfo } from '~/utils/training';
import { modelFileMetadataSchema } from '~/server/schema/model-file.schema';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockFindFirst = dbMock.dbWrite.model.findFirst;

const USER = { id: 5 } as SessionUser;

function studioWorkflow(overrides: Partial<Record<string, unknown>> = {}): Workflow {
  return {
    id: 'wf-studio-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    tags: ['training-studio'],
    metadata: { name: 'My Character', trigger: 'mychar' },
    steps: [
      {
        $type: 'training',
        startedAt: '2026-09-01T00:05:00.000Z',
        completedAt: '2026-09-01T01:00:00.000Z',
        input: {
          ecosystem: 'sdxl',
          epochs: 3,
          steps: 2000,
          samples: { prompts: ['a photo of mychar', 'mychar at the beach'] },
        },
        output: {
          moderationStatus: 'approved',
          epochs: [
            { epochNumber: 1, model: { url: 'https://blobs/epoch-1', available: true } },
            { epochNumber: 2, model: { url: 'https://blobs/epoch-2', available: false } },
            { epochNumber: 3, model: { url: 'https://blobs/epoch-3', available: true } },
          ],
        },
      },
    ],
    ...overrides,
  } as unknown as Workflow;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindFirst.mockResolvedValue(null);
  mockUpsertModel.mockResolvedValue({ id: 100 });
  mockUpsertModelVersion.mockResolvedValue({ id: 200 });
  mockCreateFile.mockResolvedValue({ id: 300 });
});

describe('mapTrainingBaseModelToBaseModel', () => {
  it('resolves an exact AIR match ahead of everything else', () => {
    const [key, info] = Object.entries(trainingModelInfo).find(([, i]) => i.air)!;
    const wf = studioWorkflow({
      steps: [{ $type: 'training', input: { model: info.air, ecosystem: 'not-a-real-eco' } }],
    });
    const mapped = mapTrainingBaseModelToBaseModel(wf);
    expect(mapped.trainingKey).toBe(key);
    expect(mapped.baseModel).toBe(info.baseModel);
  });

  it('resolves an AI-Toolkit ecosystem + variant to the variant-matched entry', () => {
    const entries = Object.entries(trainingModelInfo).filter(
      ([, i]) => i.aiToolkit?.ecosystem === 'wan'
    );
    const v22 = entries.find(([, i]) => i.aiToolkit?.modelVariant === '2.2');
    expect(v22).toBeDefined();
    const wf = studioWorkflow({
      steps: [{ $type: 'training', input: { ecosystem: 'wan', modelVariant: '2.2' } }],
    });
    expect(mapTrainingBaseModelToBaseModel(wf).trainingKey).toBe(v22![0]);
  });

  it('falls back to an ecosystem-only match when the variant is unknown', () => {
    const wf = studioWorkflow({
      steps: [{ $type: 'training', input: { ecosystem: 'wan', modelVariant: 'no-such-variant' } }],
    });
    expect(mapTrainingBaseModelToBaseModel(wf).info.aiToolkit?.ecosystem).toBe('wan');
  });

  it('throws for a base outside trainingModelInfo instead of writing a malformed version', () => {
    const wf = studioWorkflow({
      steps: [{ $type: 'training', input: { ecosystem: 'not-a-real-eco' } }],
    });
    expect(() => mapTrainingBaseModelToBaseModel(wf)).toThrow(/no longer be published/);
  });
});

describe('mapWorkflowToTrainingResultsV2', () => {
  it('maps a training step, dropping epochs whose blob is unavailable', () => {
    const results = mapWorkflowToTrainingResultsV2(studioWorkflow());
    expect(results.workflowId).toBe('wf-studio-1');
    expect(results.epochs.map((e) => e.epochNumber)).toEqual([1, 3]);
    expect(results.epochs[1].modelUrl).toBe('https://blobs/epoch-3');
    expect(results.sampleImagesPrompts).toEqual(['a photo of mychar', 'mychar at the beach']);
  });

  it('keeps a missing sample in its slot so sample N stays prompt N', () => {
    const results = mapWorkflowToTrainingResultsV2(
      studioWorkflow({
        steps: [
          {
            $type: 'training',
            input: { samples: { prompts: ['a', 'b', 'c'] } },
            output: {
              epochs: [
                {
                  epochNumber: 1,
                  model: { url: 'https://blobs/epoch-1', available: true },
                  samples: [
                    { url: null },
                    { url: 'https://blobs/s-1-2', available: true },
                    { url: 'https://blobs/s-1-3', available: false },
                  ],
                },
              ],
            },
          },
        ],
      })
    );

    expect(results.epochs[0].sampleImages).toEqual(['', 'https://blobs/s-1-2', '']);
    // The write gate a client round-trip goes through must accept the placeholders.
    expect(() => modelFileMetadataSchema.parse({ trainingResults: results })).not.toThrow();
  });

  it('keeps an empty legacy sample in its slot', () => {
    const results = mapWorkflowToTrainingResultsV2({
      id: 'wf-legacy-gap',
      steps: [
        {
          $type: 'imageResourceTraining',
          output: {
            sampleImagesPrompts: ['a', 'b'],
            epochs: [
              {
                epochNumber: 1,
                blobUrl: 'https://blobs/l-1',
                sampleImages: ['', 'https://blobs/l-1-b'],
              },
            ],
          },
        },
      ],
    } as unknown as Workflow);

    expect(results.epochs[0].sampleImages).toEqual(['', 'https://blobs/l-1-b']);
  });

  it('maps a legacy imageResourceTraining step off blobUrl/blobSize', () => {
    const wf = studioWorkflow({
      steps: [
        {
          $type: 'imageResourceTraining',
          output: {
            sampleImagesPrompts: ['legacy prompt'],
            epochs: [
              { epochNumber: 1, blobUrl: 'https://blobs/legacy-1', blobSize: 42, sampleImages: [] },
            ],
          },
        },
      ],
    });
    const results = mapWorkflowToTrainingResultsV2(wf);
    expect(results.epochs).toEqual([
      { epochNumber: 1, modelUrl: 'https://blobs/legacy-1', modelSize: 42, sampleImages: [] },
    ]);
    expect(results.sampleImagesPrompts).toEqual(['legacy prompt']);
  });
});

describe('createDraftModelFromWorkflow', () => {
  it('scopes the idempotency lookup to the caller — the where clause carries userId + workflowId', async () => {
    await createDraftModelFromWorkflow({
      user: USER,
      workflow: studioWorkflow(),
      selectedEpochNumber: 3,
    });
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where.userId).toBe(USER.id);
    expect(where.meta).toEqual({ path: ['trainingStudioWorkflowId'], equals: 'wf-studio-1' });
  });

  it('returns the existing draft ids without creating anything', async () => {
    mockFindFirst.mockResolvedValue({ id: 77, modelVersions: [{ id: 88 }] });
    const result = await createDraftModelFromWorkflow({
      user: USER,
      workflow: studioWorkflow(),
      selectedEpochNumber: 3,
    });
    expect(result).toEqual({
      modelId: 77,
      modelVersionId: 88,
      selectedEpoch: expect.objectContaining({
        epochNumber: 3,
        modelUrl: 'https://blobs/epoch-3',
      }),
    });
    expect(mockUpsertModel).not.toHaveBeenCalled();
    expect(mockUpsertModelVersion).not.toHaveBeenCalled();
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  it('re-entry on an existing draft whose blobs expired resolves the ids with a null epoch instead of throwing', async () => {
    mockFindFirst.mockResolvedValue({ id: 77, modelVersions: [{ id: 88 }] });
    const wf = studioWorkflow({
      steps: [
        {
          $type: 'training',
          input: { ecosystem: 'sdxl' },
          output: { moderationStatus: 'approved', epochs: [] },
        },
      ],
    });
    const result = await createDraftModelFromWorkflow({
      user: USER,
      workflow: wf,
      selectedEpochNumber: 3,
    });
    expect(result).toEqual({ modelId: 77, modelVersionId: 88, selectedEpoch: null });
  });

  it('refuses a run with no downloadable checkpoint before any write', async () => {
    const wf = studioWorkflow({
      steps: [
        {
          $type: 'training',
          input: { ecosystem: 'sdxl' },
          output: { moderationStatus: 'approved', epochs: [] },
        },
      ],
    });
    await expect(
      createDraftModelFromWorkflow({ user: USER, workflow: wf, selectedEpochNumber: 1 })
    ).rejects.toThrow(/no downloadable checkpoint/);
    expect(mockUpsertModel).not.toHaveBeenCalled();
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  it('creates the Draft chain stamped with the workflow id, off the selected epoch', async () => {
    const result = await createDraftModelFromWorkflow({
      user: USER,
      workflow: studioWorkflow(),
      selectedEpochNumber: 1,
    });
    expect(result).toEqual({
      modelId: 100,
      modelVersionId: 200,
      selectedEpoch: expect.objectContaining({
        epochNumber: 1,
        modelUrl: 'https://blobs/epoch-1',
      }),
    });

    const model = mockUpsertModel.mock.calls[0][0];
    expect(model).toMatchObject({
      name: 'My Character',
      status: 'Draft',
      uploadType: 'Trained',
      userId: USER.id,
      serverMeta: {
        trainingStudioWorkflowId: 'wf-studio-1',
        trainingStudioModerationApproved: true,
      },
    });

    const version = mockUpsertModelVersion.mock.calls[0][0];
    expect(version).toMatchObject({
      modelId: 100,
      status: 'Draft',
      trainedWords: ['mychar'],
    });
    expect(version.trainingDetails.params.ecosystem).toBe('sdxl');

    const file = mockCreateFile.mock.calls[0][0];
    expect(file.modelVersionId).toBe(200);
    expect(file.metadata.selectedEpochUrl).toBe('https://blobs/epoch-1');
    expect(file.metadata.trainingResults.epochs).toHaveLength(2);
  });

  it('falls back to the last available epoch when the selected number has no blob', async () => {
    await createDraftModelFromWorkflow({
      user: USER,
      workflow: studioWorkflow(),
      selectedEpochNumber: 99,
    });
    expect(mockCreateFile.mock.calls[0][0].metadata.selectedEpochUrl).toBe('https://blobs/epoch-3');
  });
});

/** A finished studio run whose training step reports `moderationStatus` (or none, when undefined). */
function runWithModeration(moderationStatus: string | undefined, stepType = 'training'): Workflow {
  const [, info] = Object.entries(trainingModelInfo).find(([, i]) => i.air)!;
  const output =
    stepType === 'training'
      ? {
          epochs: [{ epochNumber: 1, model: { url: 'https://blobs/epoch-1', available: true } }],
        }
      : { sampleImagesPrompts: [], epochs: [{ epochNumber: 1, blobUrl: 'https://blobs/l-1' }] };
  return studioWorkflow({
    steps: [
      {
        $type: stepType,
        input: { model: info.air, ecosystem: 'sdxl' },
        output: moderationStatus === undefined ? output : { ...output, moderationStatus },
      },
    ],
  });
}

const NOT_APPROVED = /dataset has not been approved/;
const REFUSED_STATUSES = ['evaluating', 'underReview', 'rejected'];

describe('training moderation gate — createDraftModelFromWorkflow', () => {
  it.each(['training', 'imageResourceTraining'])(
    'materializes an approved %s run',
    async (stepType) => {
      const result = await createDraftModelFromWorkflow({
        user: USER,
        workflow: runWithModeration('approved', stepType),
        selectedEpochNumber: 1,
      });
      expect(result.modelId).toBe(100);
      expect(mockCreateFile).toHaveBeenCalledTimes(1);
    }
  );

  describe.each(['training', 'imageResourceTraining'])('%s step', (stepType) => {
    it.each(REFUSED_STATUSES)(
      'refuses a run whose moderation status is %s, before any read or write',
      async (status) => {
        await expect(
          createDraftModelFromWorkflow({
            user: USER,
            workflow: runWithModeration(status, stepType),
            selectedEpochNumber: 1,
          })
        ).rejects.toThrow(NOT_APPROVED);
        expect(mockFindFirst).not.toHaveBeenCalled();
        expect(mockUpsertModel).not.toHaveBeenCalled();
        expect(mockUpsertModelVersion).not.toHaveBeenCalled();
        expect(mockCreateFile).not.toHaveBeenCalled();
      }
    );

    it('refuses a run that reports no moderation status', async () => {
      await expect(
        createDraftModelFromWorkflow({
          user: USER,
          workflow: runWithModeration(undefined, stepType),
          selectedEpochNumber: 1,
        })
      ).rejects.toThrow(NOT_APPROVED);
      expect(mockUpsertModel).not.toHaveBeenCalled();
      expect(mockCreateFile).not.toHaveBeenCalled();
    });
  });

  it('refuses a run with no output at all', async () => {
    const wf = studioWorkflow({ steps: [{ $type: 'training', input: { ecosystem: 'sdxl' } }] });
    await expect(
      createDraftModelFromWorkflow({ user: USER, workflow: wf, selectedEpochNumber: 1 })
    ).rejects.toThrow(NOT_APPROVED);
  });

  it.each(REFUSED_STATUSES)(
    're-entry on an already-materialized draft is refused too when the status is %s',
    async (status) => {
      mockFindFirst.mockResolvedValue({ id: 77, modelVersions: [{ id: 88 }] });
      await expect(
        createDraftModelFromWorkflow({
          user: USER,
          workflow: runWithModeration(status),
          selectedEpochNumber: 1,
        })
      ).rejects.toThrow(NOT_APPROVED);
    }
  );
});

describe('training moderation gate — assertTrainingSourcePublishable', () => {
  const STAMPED = {
    trainingStudioWorkflowId: 'wf-studio-1',
    trainingStudioModerationApproved: true,
  };
  const UNSTAMPED = { trainingStudioWorkflowId: 'wf-studio-1' };
  const args = { modelId: 42, meta: UNSTAMPED, ownerId: 5, callerId: 5 };
  /** The approval-stamp writes made, as [modelId]. */
  const stampWrites = () =>
    dbMock.dbWrite.$executeRaw.mock.calls.map((call) => (call as unknown[]).slice(1));

  beforeEach(() => {
    mockGetToken.mockResolvedValue('owner-token');
  });

  it.each([null, undefined, {}])(
    'does not read anything for a model whose meta (%s) names no workflow',
    async (meta) => {
      await expect(assertTrainingSourcePublishable({ ...args, meta })).resolves.toBeUndefined();
      expect(mockGetWorkflow).not.toHaveBeenCalled();
      expect(mockGetToken).not.toHaveBeenCalled();
    }
  );

  // Case 1
  it('passes a stamped model without reading its workflow', async () => {
    mockGetWorkflow.mockResolvedValue(runWithModeration('rejected'));
    await expect(
      assertTrainingSourcePublishable({ ...args, meta: STAMPED })
    ).resolves.toBeUndefined();
    expect(mockGetWorkflow).not.toHaveBeenCalled();
    expect(stampWrites()).toEqual([]);
  });

  // Case 2
  it('allows an approved run, reading it with the owner token, and backfills the stamp', async () => {
    mockGetWorkflow.mockResolvedValue(runWithModeration('approved'));
    await expect(assertTrainingSourcePublishable(args)).resolves.toBeUndefined();
    expect(mockGetToken).toHaveBeenCalledWith(5, undefined, { bypassCache: false });
    expect(mockGetWorkflow).toHaveBeenCalledWith({
      token: 'owner-token',
      path: { workflowId: 'wf-studio-1' },
    });
    expect(stampWrites()).toEqual([[42]]);
  });

  it('mints the owner token with the cache bypass when a moderator publishes', async () => {
    mockGetWorkflow.mockResolvedValue(runWithModeration('approved'));
    await assertTrainingSourcePublishable({ ...args, callerId: 999 });
    expect(mockGetToken).toHaveBeenCalledWith(5, undefined, { bypassCache: true });
  });

  it.each([...REFUSED_STATUSES, undefined])(
    'refuses a readable run whose status is %s, and does not stamp',
    async (status) => {
      mockGetWorkflow.mockResolvedValue(runWithModeration(status));
      await expect(assertTrainingSourcePublishable(args)).rejects.toThrow(NOT_APPROVED);
      expect(stampWrites()).toEqual([]);
    }
  );

  it('refuses a readable unapproved run when the stamp is explicitly false', async () => {
    mockGetWorkflow.mockResolvedValue(runWithModeration('rejected'));
    await expect(
      assertTrainingSourcePublishable({
        ...args,
        meta: { ...UNSTAMPED, trainingStudioModerationApproved: false },
      })
    ).rejects.toThrow(NOT_APPROVED);
  });

  it('marks a refusal so callers can tell it from other errors', async () => {
    mockGetWorkflow.mockResolvedValue(runWithModeration('rejected'));
    const error = await assertTrainingSourcePublishable(args).catch((e: unknown) => e);
    expect(isTrainingNotApprovedRefusal(error)).toBe(true);
    expect(isTrainingNotApprovedRefusal(new Error('dataset has not been approved'))).toBe(false);
  });

  it('still passes when the stamp write fails', async () => {
    mockGetWorkflow.mockResolvedValue(runWithModeration('approved'));
    dbMock.dbWrite.$executeRaw.mockRejectedValueOnce(new Error('db down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(assertTrainingSourcePublishable(args)).resolves.toBeUndefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // Case 3
  it('passes an unstamped model whose workflow the orchestrator no longer returns (NOT_FOUND)', async () => {
    mockGetWorkflow.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND', message: 'gone' }));
    await expect(assertTrainingSourcePublishable(args)).resolves.toBeUndefined();
    expect(stampWrites()).toEqual([]);
  });

  it('rethrows any other read failure instead of publishing unchecked', async () => {
    mockGetWorkflow.mockRejectedValue(
      new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'orchestrator down' })
    );
    await expect(assertTrainingSourcePublishable(args)).rejects.toThrow('orchestrator down');
  });
});

/**
 * A finished run whose checkpoint blobs have expired, in the shape the orchestrator returns it: the
 * epochs are still listed with `available: false`, and the moderation status is still reported
 * (it is derived from the step's jobs, not from the blobs).
 */
function expiredRun(moderationStatus: string | undefined): Workflow {
  return studioWorkflow({
    steps: [
      {
        $type: 'training',
        input: { ecosystem: 'sdxl' },
        output: {
          ...(moderationStatus !== undefined && { moderationStatus }),
          epochs: [
            { epochNumber: 1, model: { id: 'b1', available: false } },
            { epochNumber: 2, model: { id: 'b2', available: false } },
          ],
        },
      },
    ],
  });
}

describe('approval stamp on re-entry', () => {
  it('stamps an approved re-entry on a draft that has no stamp yet', async () => {
    mockFindFirst.mockResolvedValue({
      id: 77,
      meta: { trainingStudioWorkflowId: 'wf-studio-1' },
      modelVersions: [{ id: 88 }],
    });
    await createDraftModelFromWorkflow({
      user: USER,
      workflow: studioWorkflow(),
      selectedEpochNumber: 3,
    });
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = dbMock.dbWrite.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    expect(sql.join('$1').replace(/\s+/g, ' ').trim()).toBe(
      `UPDATE "Model" SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{trainingStudioModerationApproved}', 'true'::jsonb) WHERE id = $1`
    );
    expect(values).toEqual([77]);
  });

  it('still returns the draft when the stamp write fails', async () => {
    mockFindFirst.mockResolvedValue({ id: 77, meta: null, modelVersions: [{ id: 88 }] });
    dbMock.dbWrite.$executeRaw.mockRejectedValueOnce(new Error('db down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      createDraftModelFromWorkflow({
        user: USER,
        workflow: studioWorkflow(),
        selectedEpochNumber: 3,
      })
    ).resolves.toMatchObject({ modelId: 77, modelVersionId: 88 });
    consoleSpy.mockRestore();
  });

  it('does not write when the draft already carries the stamp', async () => {
    mockFindFirst.mockResolvedValue({
      id: 77,
      meta: { trainingStudioWorkflowId: 'wf-studio-1', trainingStudioModerationApproved: true },
      modelVersions: [{ id: 88 }],
    });
    await createDraftModelFromWorkflow({
      user: USER,
      workflow: studioWorkflow(),
      selectedEpochNumber: 3,
    });
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('does not stamp a re-entry the gate refuses', async () => {
    mockFindFirst.mockResolvedValue({ id: 77, meta: null, modelVersions: [{ id: 88 }] });
    await expect(
      createDraftModelFromWorkflow({
        user: USER,
        workflow: runWithModeration('rejected'),
        selectedEpochNumber: 1,
      })
    ).rejects.toThrow(NOT_APPROVED);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('training moderation gate — runs whose blobs have expired', () => {
  it('re-entry on an existing draft of an approved expired run resolves with a null epoch', async () => {
    mockFindFirst.mockResolvedValue({ id: 77, modelVersions: [{ id: 88 }] });
    await expect(
      createDraftModelFromWorkflow({
        user: USER,
        workflow: expiredRun('approved'),
        selectedEpochNumber: 2,
      })
    ).resolves.toEqual({ modelId: 77, modelVersionId: 88, selectedEpoch: null });
  });

  it('a first entry on an approved expired run is refused for having no checkpoint, not by the gate', async () => {
    await expect(
      createDraftModelFromWorkflow({
        user: USER,
        workflow: expiredRun('approved'),
        selectedEpochNumber: 1,
      })
    ).rejects.toThrow(/no downloadable checkpoint/);
    expect(mockUpsertModel).not.toHaveBeenCalled();
  });

  it.each(['rejected', undefined])(
    'an expired run reporting %s is refused by the gate, on re-entry too',
    async (status) => {
      mockFindFirst.mockResolvedValue({ id: 77, modelVersions: [{ id: 88 }] });
      await expect(
        createDraftModelFromWorkflow({
          user: USER,
          workflow: expiredRun(status),
          selectedEpochNumber: 1,
        })
      ).rejects.toThrow(NOT_APPROVED);
    }
  );
});

describe('stampWorkflowDraftModel', () => {
  beforeEach(() => {
    mockUpdateWorkflow.mockResolvedValue({});
  });

  it('merges the draft ids into the existing metadata without a `published` flag', async () => {
    await stampWorkflowDraftModel({
      token: 'tok',
      workflow: studioWorkflow(),
      modelId: 42,
      modelVersionId: 43,
    });
    expect(mockUpdateWorkflow).toHaveBeenCalledWith({
      token: 'tok',
      workflowId: 'wf-studio-1',
      metadata: {
        name: 'My Character',
        trigger: 'mychar',
        modelId: 42,
        modelVersionId: 43,
      },
    });
  });

  it('no-ops when the same ids are already stamped — the idempotent re-entry costs nothing', async () => {
    const wf = studioWorkflow({
      metadata: { name: 'My Character', modelId: 42, modelVersionId: 43 },
    });
    await stampWorkflowDraftModel({ token: 'tok', workflow: wf, modelId: 42, modelVersionId: 43 });
    expect(mockUpdateWorkflow).not.toHaveBeenCalled();
  });

  it('never throws — the publish entry must not fail on a stamp error', async () => {
    mockUpdateWorkflow.mockRejectedValue(new Error('orchestrator down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      stampWorkflowDraftModel({
        token: 'tok',
        workflow: studioWorkflow(),
        modelId: 42,
        modelVersionId: 43,
      })
    ).resolves.toBeUndefined();
    consoleSpy.mockRestore();
  });
});

describe('stampWorkflowPublished', () => {
  beforeEach(() => {
    mockGetToken.mockResolvedValue('owner-token');
    mockGetWorkflow.mockResolvedValue({
      id: 'wf-studio-1',
      metadata: { name: 'My Character', trigger: 'mychar', v: 1 },
    });
    mockUpdateWorkflow.mockResolvedValue({});
  });

  it('merges the publish stamp into the existing metadata instead of replacing it', async () => {
    await stampWorkflowPublished({
      ownerId: 5,
      callerId: 5,
      workflowId: 'wf-studio-1',
      modelId: 42,
      modelVersionId: 43,
    });
    expect(mockUpdateWorkflow).toHaveBeenCalledWith({
      token: 'owner-token',
      workflowId: 'wf-studio-1',
      metadata: {
        name: 'My Character',
        trigger: 'mychar',
        v: 1,
        published: true,
        modelId: 42,
        modelVersionId: 43,
      },
    });
  });

  it('mints the token for the model OWNER, bypassing the per-pod cache when a moderator publishes', async () => {
    await stampWorkflowPublished({
      ownerId: 5,
      callerId: 999,
      workflowId: 'wf-studio-1',
      modelId: 42,
    });
    expect(mockGetToken).toHaveBeenCalledWith(5, undefined, { bypassCache: true });

    mockGetToken.mockClear();
    await stampWorkflowPublished({
      ownerId: 5,
      callerId: 5,
      workflowId: 'wf-studio-1',
      modelId: 42,
    });
    expect(mockGetToken).toHaveBeenCalledWith(5, undefined, { bypassCache: false });
  });

  it('never throws — an unreachable orchestrator must not fail the publish', async () => {
    mockUpdateWorkflow.mockRejectedValue(new Error('orchestrator down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      stampWorkflowPublished({ ownerId: 5, callerId: 5, workflowId: 'wf-studio-1', modelId: 42 })
    ).resolves.toBeUndefined();
    consoleSpy.mockRestore();
  });
});
