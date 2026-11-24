import { describe, expect, it, vi } from 'vitest';
import { MatureRepriceError } from '$lib/mature-charge';
import { FilesProcessingError, FILES_PROCESSING_CODE } from '$lib/files-processing';
import { TrainingBatchValidationError, TrainingSubmitError } from '$lib/train-core';

const submitTrainingBatch = vi.fn();
const logToAxiom = vi.fn();
vi.mock('$lib/server/axiom', () => ({ logToAxiom, safeError: (e: unknown) => e }));
// Empty: the client's dist imports a directory, which Node's ESM loader refuses; the route needs none of it.
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/text-check', () => ({
  textCheckCookie: () => null,
  throwTextCheckHttpError: () => undefined,
}));
let kohyaAllowed = false;
vi.mock('$lib/server/flipt', () => ({
  isKohyaAllowed: async () => kohyaAllowed,
  flagVariant: async () => null,
}));
vi.mock('$lib/server/train', () => ({
  submitTrainingBatch: (...args: unknown[]) => submitTrainingBatch(...args),
}));

const { POST } = await import('./+server');

const post = (body: unknown) =>
  POST({
    locals: { user: { id: 1 } },
    request: new Request('http://x/api/train', { method: 'POST', body: JSON.stringify(body) }),
  } as unknown as Parameters<typeof POST>[0]);

describe('POST /api/train', () => {
  it('answers 409 with the mature count when a Green-paid run must be repriced as mature', async () => {
    const refusal = new MatureRepriceError(3);
    submitTrainingBatch.mockRejectedValueOnce(refusal);
    await expect(post({ runs: [] })).rejects.toMatchObject({
      status: 409,
      body: { message: refusal.message, matureCount: 3 },
    });
  });

  it("passes the user's Kohya gate to the submit", async () => {
    submitTrainingBatch.mockResolvedValue({ workflowIds: ['wf-1'] });
    for (const allowed of [true, false]) {
      kohyaAllowed = allowed;
      await post({ runs: [] });
      expect(submitTrainingBatch.mock.calls.at(-1)![5]).toBe(allowed);
    }
  });

  // The refused answer goes back to the browser only; without this row support can't see why a user's
  // Start was refused.
  it.each([
    [
      'a validation refusal',
      new TrainingBatchValidationError('runs[0].trigger is required.'),
      400,
      undefined,
    ],
    ['dataset files still processing', new FilesProcessingError(), 400, FILES_PROCESSING_CODE],
    ['an orchestrator refusal', new TrainingSubmitError('bad dataset', 422), 400, undefined],
    ['a mature reprice', new MatureRepriceError(2), 409, undefined],
  ])('logs %s with the user, status and reason', async (_, refusal, status, code) => {
    logToAxiom.mockClear();
    submitTrainingBatch.mockRejectedValueOnce(refusal);
    const thrown = await Promise.resolve()
      .then(() => post({ runs: [{}] }))
      .catch((e: unknown) => e);
    expect(thrown).toMatchObject({ status });
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'training-studio-train-refused',
        userId: 1,
        status,
        message: (thrown as { body: { message: string } }).body.message,
        code,
      })
    );
  });

  it('logs a continuation refused before the submit', async () => {
    logToAxiom.mockClear();
    await expect(post({ runs: [{ continueFrom: 'wf' }] })).rejects.toMatchObject({ status: 400 });
    expect(logToAxiom).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, status: 400 }));
  });

  it('does not log a batch that started', async () => {
    logToAxiom.mockClear();
    submitTrainingBatch.mockResolvedValueOnce({ workflowIds: ['wf-1'] });
    await post({ runs: [{}] });
    expect(logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'training-studio-train-refused' })
    );
  });
});
