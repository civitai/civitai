import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * A real (paid) orchestrator submit is bounded, and a bounded submit that runs out of time tells
 * the user their request may already be queued instead of hanging or 500ing.
 *
 * The generate path used to pass no signal at all, so an orchestrator that accepted the
 * connection and never answered parked the request for as long as the socket lived, three times
 * over (the wrapper retries a status-less failure). Each attempt is now capped and the whole
 * submit has one deadline. A timed-out attempt may still have been accepted (and charged), and
 * it may still be in flight, so it is never retried, key or not: the error says the job may be
 * queued, and a re-click is a decision the user makes after looking, not a blind second charge.
 * A 5xx or a network error is still retried, as before.
 *
 * A caller that asks the orchestrator to hold the request open (`query.wait`, in seconds) gets a
 * budget of at least that wait plus a margin, so the bound never cuts off a wait it asked for.
 *
 * The orchestrator stub settles ONLY when the signal it was handed aborts: with no signal it
 * never settles at all, which is exactly the pre-fix behaviour, and the bounded loop below turns
 * that into a readable `submit never settled` failure rather than a hung test.
 */

const { mockSubmitWorkflow } = vi.hoisted(() => ({ mockSubmitWorkflow: vi.fn() }));

vi.mock('@civitai/orchestration-client', () => ({
  submitWorkflow: mockSubmitWorkflow,
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  removeWorkflowTag: vi.fn(),
  updateWorkflow: vi.fn(),
  refreshBlob: vi.fn(),
  handleError: vi.fn((e: unknown) => (typeof e === 'string' ? e : 'err')),
}));

vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: vi.fn(() => ({})),
  internalOrchestratorClient: {},
}));

vi.mock('~/env/other', () => ({ isDev: false, isProd: true }));

import { submitWorkflow } from '~/server/services/orchestrator/workflows';

type StubOptions = { signal?: AbortSignal; body?: { externalId?: string } };

/** The real client's resolve shape on a fired abort: `{ error, response: undefined }`. */
function settleOnlyOnAbort({ signal }: StubOptions) {
  return new Promise((resolve) => {
    if (!signal) return; // never settles: an unbounded submit hangs here forever
    signal.addEventListener(
      'abort',
      () => resolve({ data: undefined, response: undefined, error: signal.reason }),
      { once: true }
    );
  });
}

/** Same, for a client configured to throw: rejects with the abort reason. */
function rejectOnlyOnAbort({ signal }: StubOptions) {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Drive fake time 1s at a time until the submit settles, capped at 120s of fake time. */
async function runUntilSettled(run: () => Promise<unknown>) {
  const start = Date.now();
  let settled: { ok: boolean; value: unknown } | undefined;
  run().then(
    (value) => (settled = { ok: true, value }),
    (value) => (settled = { ok: false, value })
  );
  for (let i = 0; i < 120 && !settled; i++) await vi.advanceTimersByTimeAsync(1_000);
  return { settled, elapsedMs: Date.now() - start };
}

const KEY = 'idem-key-0001';
const generate = (body: Record<string, unknown> = { steps: [], externalId: KEY }) =>
  submitWorkflow({ token: 'tok', body: body as never, source: 'generate' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  delete process.env.ORCHESTRATOR_SUBMIT_BOUNDS;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.ORCHESTRATOR_SUBMIT_BOUNDS;
});

describe('submitWorkflow — a real submit to an orchestrator that never answers', () => {
  it.each([
    ['resolves on abort', settleOnlyOnAbort],
    ['rejects on abort', rejectOnlyOnAbort],
  ])(
    'ends in a 503 saying the request may be queued, after one 30s attempt (client %s)',
    async (_label, stub) => {
      mockSubmitWorkflow.mockImplementation(stub);

      const { settled, elapsedMs } = await runUntilSettled(() => generate());

      expect(settled, 'submit never settled within 120s of fake time').toBeDefined();
      expect(settled?.ok).toBe(false);
      const err = settled?.value as TRPCError;
      expect(err).toBeInstanceOf(TRPCError);
      expect(err.code).toBe('SERVICE_UNAVAILABLE');
      expect(err.message).toMatch(/may already be queued/i);
      expect(err.message).toMatch(/check your queue before retrying/i);
      // The attempt gets its full 30s, and is the only one.
      expect(elapsedMs).toBeGreaterThanOrEqual(30_000);
      expect(elapsedMs).toBeLessThanOrEqual(31_000);

      // Bounded, and NOT retried even though it carries a key: attempt 1 may still be in flight,
      // and a second attempt is only safe if the orchestrator's dedupe is atomic.
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
      expect((mockSubmitWorkflow.mock.calls[0][0] as StubOptions).signal).toBeInstanceOf(
        AbortSignal
      );
    }
  );

  it('does not resubmit a timed-out attempt when the body carries no idempotency key', async () => {
    mockSubmitWorkflow.mockImplementation(settleOnlyOnAbort);

    const { settled, elapsedMs } = await runUntilSettled(() => generate({ steps: [] }));

    expect(settled, 'submit never settled within 120s of fake time').toBeDefined();
    const err = settled?.value as TRPCError;
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(err.message).toMatch(/may already be queued/i);
    // The attempt may have been accepted; without a key a second one could be a second charge.
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(30_000);
    expect(elapsedMs).toBeLessThanOrEqual(31_000);
  });

  // The queue wording is for the generation form, where the user has a queue to check. Every other
  // caller (training, scans, comics, resource loads) keeps the same bounds but the generic copy.
  it.each([['other'], ['preset'], [undefined]] as const)(
    'a non-generate submit (source %s) that runs out of time gets the generic 503 copy',
    async (source) => {
      mockSubmitWorkflow.mockImplementation(settleOnlyOnAbort);

      const { settled, elapsedMs } = await runUntilSettled(() =>
        submitWorkflow({
          token: 'tok',
          body: { steps: [], externalId: KEY } as never,
          ...(source ? { source } : {}),
        })
      );

      expect(settled, 'submit never settled within 120s of fake time').toBeDefined();
      const err = settled?.value as TRPCError;
      expect(err).toBeInstanceOf(TRPCError);
      expect(err.code).toBe('SERVICE_UNAVAILABLE');
      expect(err.message).toBe(
        'Generation services are temporarily unavailable. Please try again.'
      );
      // Same bounds as generate.
      expect(elapsedMs).toBeLessThanOrEqual(61_000);
    }
  );

  it('still retries a 5xx, with the same key, and succeeds', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce({ data: undefined, response: { status: 502 } })
      .mockResolvedValueOnce({ data: { id: 'wf-1' }, response: { status: 200 } });

    const { settled } = await runUntilSettled(() => generate());

    expect(settled).toEqual({ ok: true, value: { id: 'wf-1' } });
    const keys = mockSubmitWorkflow.mock.calls.map((c) => (c[0] as StubOptions).body?.externalId);
    expect(keys).toEqual([KEY, KEY]);
  });

  it('ORCHESTRATOR_SUBMIT_BOUNDS=off restores the unbounded submit (the off-switch works)', async () => {
    process.env.ORCHESTRATOR_SUBMIT_BOUNDS = 'off';
    mockSubmitWorkflow.mockResolvedValue({ data: { id: 'wf-1' }, response: { status: 200 } });

    const { settled } = await runUntilSettled(() => generate());

    expect(settled).toEqual({ ok: true, value: { id: 'wf-1' } });
    expect((mockSubmitWorkflow.mock.calls[0][0] as StubOptions).signal).toBeUndefined();
  });
});

/** Answers successfully after `ms`, unless the signal it was handed aborts first. */
const answerAfter =
  (ms: number) =>
  ({ signal }: StubOptions) =>
    new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ data: { id: 'wf-wait' }, response: { status: 200 } }),
        ms
      );
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve({ data: undefined, response: undefined, error: signal.reason });
        },
        { once: true }
      );
    });

describe('submitWorkflow — a caller that asks the orchestrator to wait (query.wait)', () => {
  // `wait` is in seconds. Callers hold the request open for a chat completion or a scan; the
  // per-attempt cap and the deadline must not cut that off, or the user is charged for a
  // workflow they are told failed. 95s is the reply that arrives just after the wait expires (the
  // orchestrator answers at the end of the wait): it is what the margin above the wait is for.
  it.each([[45_000], [80_000], [95_000]])(
    'a wait=90 submit answered at %ims succeeds instead of being cut off',
    async (answerMs) => {
      mockSubmitWorkflow.mockImplementation(answerAfter(answerMs));

      const { settled, elapsedMs } = await runUntilSettled(() =>
        submitWorkflow({ token: 'tok', body: { steps: [] } as never, query: { wait: 90 } })
      );

      expect(settled).toEqual({ ok: true, value: { id: 'wf-wait' } });
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
      expect(elapsedMs).toBeGreaterThanOrEqual(answerMs);
    }
  );

  it('a wait=90 submit that never answers is still bounded: one attempt, ended by 106s', async () => {
    mockSubmitWorkflow.mockImplementation(settleOnlyOnAbort);

    const { settled, elapsedMs } = await runUntilSettled(() =>
      submitWorkflow({ token: 'tok', body: { steps: [] } as never, query: { wait: 90 } })
    );

    expect(settled, 'submit never settled within 120s of fake time').toBeDefined();
    expect((settled?.value as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(90_000);
    expect(elapsedMs).toBeLessThanOrEqual(106_000);
  });
});
