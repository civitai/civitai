import { describe, expect, it, vi } from 'vitest';
import { MatureRepriceError } from '$lib/mature-charge';

const submitTrainingBatch = vi.fn();
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
});
