import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Coverage for POST /api/webhooks/resource-training-v2/[modelVersionId].
 *
 * Production bug (root-caused from a live sweep): the handler returned HTTP 500
 * whenever the training's backing `ModelFile` was gone (deleted / orphaned
 * training). Because the orchestrator delivers this workflow callback through an
 * HttpClient wired with Polly's `AddStandardResilienceHandler()` — which retries
 * on 5xx/408/429/network but NOT on a 2xx — a single orphaned training turned
 * into a retry-amplified 500 storm (observed: 190 500s/hr, 184 of them the one
 * training id 3111039, all logging "ModelFile not found").
 *
 * The fix: distinguish the PERMANENTLY-missing record (a typed
 * `TrainingRecordNotFoundError` thrown by the service) from a genuinely
 * transient failure. The permanent case is ACKed once (200) so the orchestrator
 * stops retrying; every other failure still returns 500 so the retry can
 * legitimately recover it.
 *
 * We drive the real handler with the service layer + orchestrator workflow fetch
 * mocked, so no live DB/orchestrator is required. `TrainingRecordNotFoundError`
 * is defined INSIDE the service mock so the handler's `e instanceof
 * TrainingRecordNotFoundError` sees the exact class we throw (faithful: in prod
 * updateTrainingWorkflowRecords throws this same typed error — see
 * src/server/services/training.service.ts).
 */

// Real WorkflowStatus values (lowercase) so the handler's `z.enum(WorkflowStatus)`
// body validation accepts the statuses the switch actually handles. (The global
// test setup mocks @civitai/client with capitalized Pending/Running/Completed,
// which would reject 'succeeded' at parse time — override it here.)
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
}));

const {
  mockUpdate,
  mockGetWorkflow,
  MockPermanentTrainingWebhookError,
  MockTrainingRecordNotFoundError,
} = vi.hoisted(() => {
  class MockPermanentTrainingWebhookError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PermanentTrainingWebhookError';
    }
  }
  // Mirror the real subclass relationship so the handler's
  // `e instanceof PermanentTrainingWebhookError` matches the not-found subtype too.
  class MockTrainingRecordNotFoundError extends MockPermanentTrainingWebhookError {
    constructor(message: string) {
      super(message);
      this.name = 'TrainingRecordNotFoundError';
    }
  }
  return {
    mockUpdate: vi.fn(),
    mockGetWorkflow: vi.fn(),
    MockPermanentTrainingWebhookError,
    MockTrainingRecordNotFoundError,
  };
});

vi.mock('~/server/services/training.service', () => ({
  updateTrainingWorkflowRecords: mockUpdate,
  PermanentTrainingWebhookError: MockPermanentTrainingWebhookError,
  TrainingRecordNotFoundError: MockTrainingRecordNotFoundError,
}));

vi.mock('~/server/services/orchestrator/workflows', () => ({
  getWorkflow: mockGetWorkflow,
}));

// Passthrough wrapper (same convention as src/tests/api/v1/users/index.test.ts).
// The real WebhookEndpoint's only behavior is a `req.query.token !== env.WEBHOOK_TOKEN`
// 401 gate, which this fix does not touch; mocking it keeps the test hermetic and
// off the NextAuth/prom import chain.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: any) => handler,
}));

// Assert on the Axiom log. Re-mocked here (over the global setup mock) so this
// file owns the vi.fn it asserts against.
const { mockLogToAxiom } = vi.hoisted(() => ({
  mockLogToAxiom: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
}));

// Notification side-effects that only fire on statusChanged — kept out of the
// way so the branches under test stay isolated.
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
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));

import handler from '~/pages/api/webhooks/resource-training-v2/[modelVersionId]';

function createMocks({
  method = 'POST',
  body = { workflowId: 'wf-3111039', status: 'succeeded' },
  query = { modelVersionId: '3111039', token: 'test-webhook-token' },
}: {
  method?: string;
  body?: unknown;
  query?: Record<string, string | string[]>;
} = {}) {
  const req = { method, headers: {}, body, query } as unknown as NextApiRequest;

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

describe('/api/webhooks/resource-training-v2/[modelVersionId] — orphaned training must NOT 500-storm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkflow.mockResolvedValue({ id: 'wf-3111039', status: 'succeeded' });
  });

  it('happy path: existing ModelFile → record updated, 200', async () => {
    mockUpdate.mockResolvedValue({ statusChanged: false });
    const { req, res } = createMocks();

    await handler(req, res);

    expect(mockGetWorkflow).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wf-3111039' }),
      'succeeded'
    );
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ ok: true });
    // Happy path does not error-log.
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('missing ModelFile (permanent / orphaned training) → 200 ACK, NOT 500, and logs', async () => {
    // THE bug: id 3111039 whose ModelFile was deleted. Pre-fix this threw and the
    // catch returned an unconditional 500 → orchestrator retried → storm.
    mockUpdate.mockRejectedValue(
      new MockTrainingRecordNotFoundError('ModelFile not found: "987654"')
    );
    const { req, res } = createMocks();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getStatusCode()).not.toBe(500);
    expect(res._getJSONData()).toEqual({ ok: true, skipped: 'permanent-condition' });
    // Still logged (as a warning) for visibility.
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'resource-training-v2-webhook',
        type: 'warning',
        message: 'Permanent training-webhook condition — acking to stop orchestrator retries',
      }),
      'webhooks'
    );
  });

  it('any PermanentTrainingWebhookError (base type: malformed workflow) → 200 ACK, not 500', async () => {
    // Sibling permanent throws (Missing step data / Missing modelFileId /
    // Unsupported step type) surface as the base type — the handler must ack
    // them too, else a differently-orphaned workflow storms the same way.
    mockUpdate.mockRejectedValue(new MockPermanentTrainingWebhookError('Missing modelFileId'));
    const { req, res } = createMocks();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ ok: true, skipped: 'permanent-condition' });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning' }),
      'webhooks'
    );
  });

  it('genuine transient failure mid-update (DB error) → STILL 500 (retryable) — not masked', async () => {
    // The key anti-regression: a real transient failure must keep 5xx so the
    // orchestrator's retry can recover it. A plain Error is NOT a
    // TrainingRecordNotFoundError, so it falls through to 500.
    mockUpdate.mockRejectedValue(new Error('write CONN_RESET: db connection reset'));
    const { req, res } = createMocks();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(500);
    expect(res._getStatusCode()).not.toBe(200);
    expect(res._getJSONData()).toEqual(
      expect.objectContaining({ ok: false, error: 'write CONN_RESET: db connection reset' })
    );
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'resource-training-v2-webhook',
        type: 'error',
        message: 'Failed to update record',
      }),
      'webhooks'
    );
  });

  it('transient orchestrator fetch failure (getWorkflow throws) → STILL 500', async () => {
    // A dependency (orchestrator API) being unreachable is transient — retryable.
    mockGetWorkflow.mockRejectedValue(new Error('orchestrator unreachable'));
    const { req, res } = createMocks();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(500);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Failed to update record' }),
      'webhooks'
    );
  });

  it('non-POST method → 405 (unchanged)', async () => {
    const { req, res } = createMocks({ method: 'GET' });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(405);
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('unparseable body → 400 (unchanged), never reaches the service', async () => {
    const { req, res } = createMocks({ body: { nope: true } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });
});
