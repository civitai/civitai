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
import type { SessionUser } from '~/types/session';
import {
  createDraftModelFromWorkflow,
  mapTrainingBaseModelToBaseModel,
  mapWorkflowToTrainingResultsV2,
  stampWorkflowDraftModel,
  stampWorkflowPublished,
} from '~/server/services/orchestrator/training/publish-from-workflow';
import { trainingModelInfo } from '~/utils/training';
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
      steps: [{ $type: 'training', input: { ecosystem: 'sdxl' }, output: { epochs: [] } }],
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
      steps: [{ $type: 'training', input: { ecosystem: 'sdxl' }, output: { epochs: [] } }],
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
      meta: { trainingStudioWorkflowId: 'wf-studio-1' },
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
