import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * SERVICE→HANDLER CONTRACT coverage.
 *
 * The sibling test (resource-training-v2.test.ts) mocks the service and drives
 * the handler's catch branch in isolation — but that alone would still pass if
 * someone reverted `updateTrainingWorkflowRecords` to `throw new Error()` or
 * dropped the typed-error export. This file guards the real contract: it uses
 * the REAL `updateTrainingWorkflowRecords`, mocking ONLY the DB layer (so
 * `dbWrite.modelFile.findFirst` is controllable), and asserts that
 *   (a) each PERMANENT condition the real service throws → the handler acks 200
 *       (ModelFile not found + the three malformed-workflow siblings), and
 *   (b) a genuine transient DB failure → the handler still returns 500.
 * It also asserts the real service throws the real typed classes directly.
 */

// Real WorkflowStatus values + the client fns the REAL training.service imports
// at module load (getConsumerBlobUploadUrl / getWorkflow / handleError /
// submitWorkflow). Lowercase statuses so the handler's z.enum accepts them.
vi.mock('@civitai/client', () => ({
  WorkflowStatus: {
    unassigned: 'unassigned',
    preparing: 'preparing',
    scheduled: 'scheduled',
    processing: 'processing',
    failed: 'failed',
    expired: 'expired',
    canceled: 'canceled',
    succeeded: 'succeeded',
  },
  getConsumerBlobUploadUrl: vi.fn(),
  getWorkflow: vi.fn(),
  handleError: vi.fn(),
  submitWorkflow: vi.fn(),
}));

const { mockFindFirst, mockGetWorkflow } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockGetWorkflow: vi.fn(),
}));

// Mock ONLY the DB layer — the REAL service runs and throws the REAL typed errors.
vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: { modelFile: { findFirst: mockFindFirst } },
}));

// Orchestrator workflow fetch the handler calls before the real service.
vi.mock('~/server/services/orchestrator/workflows', () => ({
  getWorkflow: mockGetWorkflow,
}));

// Passthrough wrapper (auth gate untouched by this fix; keeps the test hermetic).
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: any) => handler,
}));

const { mockLogToAxiom } = vi.hoisted(() => ({
  mockLogToAxiom: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));

// Heavy / connection-opening leaf deps the service + handler import at module
// load but that the throw paths never execute — stub so import is cheap and no
// real client is constructed.
vi.mock('~/server/db/db-lag-helpers', () => ({ preventModelVersionLag: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));
vi.mock('~/server/redis/client', () => ({
  REDIS_SYS_KEYS: { TRAINING: {} },
  sysRedis: {},
  withSysReadDeadline: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/server/http/orchestrator/orchestrator.caller', () => ({ getOrchestratorCaller: vi.fn() }));
vi.mock('~/utils/s3-utils', () => ({
  deleteObject: vi.fn(),
  getB2S3Client: vi.fn(),
  getGetUrl: vi.fn(),
  getPutUrl: vi.fn(),
  getS3Client: vi.fn(),
  isB2Url: vi.fn(),
  parseKey: vi.fn(),
}));

// Notification side-effects (only fire on a SUCCESSFUL statusChanged update, which
// the throw paths never reach) — kept out of the way.
vi.mock('~/server/email/templates', () => ({
  trainingCompleteEmail: { send: vi.fn(() => Promise.resolve()) },
  trainingFailEmail: { send: vi.fn(() => Promise.resolve()) },
}));
vi.mock('~/server/signals/wrapper', () => ({
  withSignals: vi.fn((fn: () => Promise<unknown>) => fn()),
}));
vi.mock('~/server/webhooks/training-moderation.webhooks', () => ({
  queueNewTrainingModerationWebhook: vi.fn(() => Promise.resolve()),
}));

import handler from '~/pages/api/webhooks/resource-training-v2/[modelVersionId]';
import {
  PermanentTrainingWebhookError,
  TrainingRecordNotFoundError,
  updateTrainingWorkflowRecords,
} from '~/server/services/training.service';

function createMocks(body: unknown = { workflowId: 'wf-3111039', status: 'succeeded' }) {
  const req = {
    method: 'POST',
    headers: {},
    body,
    query: { modelVersionId: '3111039', token: 'test-webhook-token' },
  } as unknown as NextApiRequest;

  let statusCode = 200;
  let payload: any = undefined;
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      payload = data;
      return res;
    },
    end() {
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
  } as unknown as NextApiResponse & {
    _getStatusCode: () => number;
    _getJSONData: () => any;
  };
  return { req, res };
}

// A minimal orchestrator workflow whose single step reaches the ModelFile
// lookup (valid imageResourceTraining step + a modelFileId).
const validWorkflow = () => ({
  id: 'wf-3111039',
  status: 'succeeded',
  steps: [{ $type: 'imageResourceTraining', metadata: { modelFileId: 987654 }, output: undefined }],
});

describe('resource-training-v2 — REAL service throws are acked by the handler (contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkflow.mockImplementation(async () => validWorkflow());
  });

  it('REAL service throws TrainingRecordNotFoundError when modelFile is null (direct)', async () => {
    mockFindFirst.mockResolvedValue(null);
    await expect(
      updateTrainingWorkflowRecords(validWorkflow() as any, 'succeeded')
    ).rejects.toBeInstanceOf(TrainingRecordNotFoundError);
    // And it is a PermanentTrainingWebhookError, so the handler's base-type catch fires.
    await expect(
      updateTrainingWorkflowRecords(validWorkflow() as any, 'succeeded')
    ).rejects.toBeInstanceOf(PermanentTrainingWebhookError);
  });

  it('missing ModelFile (real not-found) → handler acks 200, not 500', async () => {
    mockFindFirst.mockResolvedValue(null);
    const { req, res } = createMocks();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getStatusCode()).not.toBe(500);
    expect(res._getJSONData()).toEqual({ ok: true, skipped: 'permanent-condition' });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning' }),
      'webhooks'
    );
  });

  it.each([
    ['Missing step data', { id: 'wf', status: 'succeeded', steps: [] }],
    [
      'Missing modelFileId',
      { id: 'wf', status: 'succeeded', steps: [{ $type: 'imageResourceTraining', metadata: {} }] },
    ],
    [
      'Unsupported step type',
      {
        id: 'wf',
        status: 'succeeded',
        steps: [{ $type: 'somethingElse', metadata: { modelFileId: 1 } }],
      },
    ],
  ])('sibling permanent case (%s) via REAL service → handler acks 200', async (_label, workflow) => {
    mockGetWorkflow.mockResolvedValue(workflow);
    const { req, res } = createMocks();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ ok: true, skipped: 'permanent-condition' });
  });

  it('transient DB failure in the REAL service (findFirst rejects) → still 500, NOT masked', async () => {
    mockFindFirst.mockRejectedValue(new Error('write CONN_RESET: db connection reset'));
    const { req, res } = createMocks();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(500);
    expect(res._getStatusCode()).not.toBe(200);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Failed to update record' }),
      'webhooks'
    );
  });
});
