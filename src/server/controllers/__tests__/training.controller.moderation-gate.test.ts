import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * A wrong URL, verb or identifier on the moderation gate fails only against a live orchestrator;
 * nothing else in the suite sends this request.
 */

const getWorkflow = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/orchestrator/workflows', () => ({ getWorkflow }));

vi.mock('~/server/services/model.service', () => ({ getModel: vi.fn() }));

import { handleDenyTrainingData } from '~/server/controllers/training.controller';

const trainingFile = (workflowId: string, completedAt?: string) => ({
  metadata: { trainingResults: { workflowId, ...(completedAt ? { completedAt } : {}) } },
  modelVersion: { trainingStatus: 'Paused' },
});

const gateCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/moderation-gate'));

const webhookCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/webhooks/resource-training-v2/'));

beforeEach(() => {
  setEnv({
    ORCHESTRATOR_ENDPOINT: 'https://orch.example',
    ORCHESTRATOR_ACCESS_TOKEN: 'orch-token',
    WEBHOOK_TOKEN: 'hook-token',
  });
  dbMock.dbWrite.modelFile.findMany.mockResolvedValue([trainingFile('wf-123')]);
  getWorkflow.mockResolvedValue({ id: 'wf-123', status: 'processing', tags: ['modelVersion:42'] });
});

afterEach(() => {
  resetEnv();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('handleDenyTrainingData', () => {
  it('POSTs the workflow-addressed moderation gate exactly once, with approved:false', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await handleDenyTrainingData({ input: { id: 42 } });

    const calls = gateCalls(fetchMock);
    expect(calls).toHaveLength(1);

    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe('https://orch.example/v1/manager/workflows/wf-123/moderation-gate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ approved: false });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer orch-token');
  });

  it('addresses the gate by the PENDING run when a version carries two workflows', async () => {
    dbMock.dbWrite.modelFile.findMany.mockResolvedValue([
      trainingFile('wf-finished', '2026-01-01T00:00:00Z'),
      trainingFile('wf-pending'),
    ]);
    getWorkflow.mockResolvedValue({
      id: 'wf-pending',
      status: 'processing',
      tags: ['modelVersion:42'],
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await handleDenyTrainingData({ input: { id: 42 } });

    expect(gateCalls(fetchMock)[0][0]).toBe(
      'https://orch.example/v1/manager/workflows/wf-pending/moderation-gate'
    );
  });

  it('throws when the orchestrator refuses the gate, so the caller cannot record a deny', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(handleDenyTrainingData({ input: { id: 42 } })).rejects.toThrow(
      'Could not connect to orchestrator'
    );
    expect(gateCalls(fetchMock)).toHaveLength(1);
  });

  it('posts the resource-training-v2 callback so the version leaves Paused', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleDenyTrainingData({ input: { id: 42 } });

    const [url, init] = webhookCalls(fetchMock)[0] as [string, RequestInit];
    expect(url).toBe('https://api.civitai.com/webhooks/resource-training-v2/42?token=hook-token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      workflowId: 'wf-123',
      status: 'processing',
    });
    expect(result.webhookFailed).toBe(false);
  });

  it('reports a refused callback without failing the deny, because the gate is already released', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: !String(url).includes('/webhooks/'),
      status: String(url).includes('/webhooks/') ? 500 : 200,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleDenyTrainingData({ input: { id: 42 } });

    expect(result.webhookFailed).toBe(true);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Gate released but the training webhook was refused; version is still Paused',
      }),
      expect.anything()
    );
  });

  it('skips the callback and reports it when the workflow has no status', async () => {
    getWorkflow.mockResolvedValue({ id: 'wf-123', status: undefined, tags: ['modelVersion:42'] });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleDenyTrainingData({ input: { id: 42 } });

    expect(gateCalls(fetchMock)).toHaveLength(1);
    expect(webhookCalls(fetchMock)).toHaveLength(0);
    expect(result.webhookFailed).toBe(true);
  });

  // The workflow id is read from ModelFile.metadata, which the model's owner can write, so an owner
  // could otherwise aim a moderator's ruling at a different run.
  it('refuses to touch the gate when the workflow belongs to another model version', async () => {
    getWorkflow.mockResolvedValue({
      id: 'wf-123',
      status: 'processing',
      tags: ['modelVersion:999'],
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(handleDenyTrainingData({ input: { id: 42 } })).rejects.toThrow(
      'Workflow does not belong to this model version'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when the workflow carries no ownership tag at all', async () => {
    getWorkflow.mockResolvedValue({ id: 'wf-123', status: 'processing', tags: [] });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(handleDenyTrainingData({ input: { id: 42 } })).rejects.toThrow(
      'Workflow does not belong to this model version'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call the orchestrator when no endpoint is configured', async () => {
    setEnv({ ORCHESTRATOR_ENDPOINT: undefined });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(handleDenyTrainingData({ input: { id: 42 } })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
