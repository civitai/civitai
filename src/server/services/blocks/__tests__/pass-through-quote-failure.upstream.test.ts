import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The link between an orchestrator RESPONSE and what a block is told about a failed
 * training quote. These drive the REAL `submitWorkflow` (its blob refresh, its
 * `throwOrchestratorFailure` mapping and its submit-failure annotation), mocking only
 * the generated client, and feed whatever it throws into the classifier — so a change
 * to how an upstream status is mapped onto a `TRPCError` cannot silently change what
 * reaches an app.
 */

const { mockSubmitWorkflow, mockRefreshBlob } = vi.hoisted(() => ({
  mockSubmitWorkflow: vi.fn(),
  mockRefreshBlob: vi.fn(),
}));

vi.mock('@civitai/client', () => ({
  submitWorkflow: mockSubmitWorkflow,
  refreshBlob: mockRefreshBlob,
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  removeWorkflowTag: vi.fn(),
  updateWorkflow: vi.fn(),
  handleError: vi.fn((e: unknown) => (typeof e === 'string' ? e : 'err')),
}));

vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: vi.fn(() => ({})),
  internalOrchestratorClient: {},
}));

vi.mock('~/env/other', () => ({ isDev: false, isProd: true }));

import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import {
  classifyQuoteFailure,
  unquotedTrainingRefusal,
} from '~/server/services/blocks/pass-through-quote-failure';

const GENERIC = 'Training needs a price quote and none could be obtained; try again.';
const UNAVAILABLE = { error: GENERIC, errorCode: 'training-quote-unavailable' };

/** The orchestrator's validation-error body, as `orchestratorErrorMessage` reads it. */
const errorReply = (status: number, messages: string[]) => ({
  data: undefined,
  error: { errors: { messages } },
  response: { status },
});

/** What the block receives when a whatif submit of `body` fails this way. */
async function refusalFor(body: Record<string, unknown> = { steps: [] }) {
  const err = await submitWorkflow({
    token: 'tok',
    body: body as never,
    query: { whatif: true } as never,
  }).then(
    () => {
      throw new Error('expected the whatif submit to fail');
    },
    (e: unknown) => e
  );
  return unquotedTrainingRefusal(classifyQuoteFailure(err, JSON.stringify(body)));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a failed training quote, from the orchestrator response to the block', () => {
  it('a 400 is a rejection that carries its validation message', async () => {
    mockSubmitWorkflow.mockResolvedValue(
      errorReply(400, ['Training requires at least 5 images, but 2 were provided.'])
    );
    expect(await refusalFor()).toEqual({
      error:
        'Training could not be priced: Training requires at least 5 images, but 2 were provided.',
      errorCode: 'training-quote-rejected',
    });
  });

  it('a 404 is a rejection too', async () => {
    mockSubmitWorkflow.mockResolvedValue(errorReply(404, ['The model was not found.']));
    expect(await refusalFor()).toEqual({
      error: 'Training could not be priced: The model was not found.',
      errorCode: 'training-quote-rejected',
    });
  });

  it('a 401 (our own service token refused) is unavailable, nothing forwarded', async () => {
    mockSubmitWorkflow.mockResolvedValue(errorReply(401, ['Authorization has been denied.']));
    expect(await refusalFor()).toEqual(UNAVAILABLE);
  });

  it('a 403 (insufficient funds) is unavailable, and the balance is not forwarded', async () => {
    mockSubmitWorkflow.mockResolvedValue(
      errorReply(403, ['Insufficient funds: balance is 120, 500 required.'])
    );
    const refusal = await refusalFor();
    expect(refusal).toEqual(UNAVAILABLE);
    expect(JSON.stringify(refusal)).not.toContain('120');
  });

  it('a 429 is unavailable', async () => {
    mockSubmitWorkflow.mockResolvedValue(errorReply(429, ['Too many requests.']));
    expect(await refusalFor()).toEqual(UNAVAILABLE);
  });

  it('a 500 is unavailable', async () => {
    mockSubmitWorkflow.mockResolvedValue(errorReply(500, ['Pricing failed.']));
    vi.useFakeTimers();
    const pending = refusalFor();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(UNAVAILABLE);
  });

  it('a blob-refresh failure before the quote is sent is unavailable, nothing forwarded', async () => {
    mockRefreshBlob.mockRejectedValue(new TypeError('fetch failed'));
    const refusal = await refusalFor({
      steps: [
        {
          $type: 'training',
          input: { images: ['https://blobs.example.com/v2/consumer/blobs/BLOB1.jpeg'] },
        },
      ],
    });
    expect(mockRefreshBlob).toHaveBeenCalledTimes(1);
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    expect(refusal).toEqual(UNAVAILABLE);
  });
});
