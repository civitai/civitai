import { describe, expect, it, vi } from 'vitest';
import { MatureAckRequiredError } from '$lib/mature-charge';

const submitTrainingBatch = vi.fn();
// Empty: the client's dist imports a directory, which Node's ESM loader refuses; the route needs none of it.
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/text-check', () => ({
  textCheckCookie: () => null,
  throwTextCheckHttpError: () => undefined,
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
  it('answers 409 with the mature count when the mature confirm is missing', async () => {
    const refusal = new MatureAckRequiredError(3);
    submitTrainingBatch.mockRejectedValueOnce(refusal);
    await expect(post({ runs: [] })).rejects.toMatchObject({
      status: 409,
      body: { message: refusal.message, matureCount: 3 },
    });
  });
});
