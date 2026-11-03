import { describe, expect, it, vi } from 'vitest';
import { MatureAckRequiredError } from '$lib/mature-charge';

const continueTrainingWhatIf = vi.fn();
const continueTraining = vi.fn();
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/text-check', () => ({
  textCheckCookie: () => null,
  throwTextCheckHttpError: () => undefined,
}));
vi.mock('$lib/server/train', async () => ({
  continueTraining: (...args: unknown[]) => continueTraining(...args),
  continueTrainingWhatIf: (...args: unknown[]) => continueTrainingWhatIf(...args),
  MatureAckRequiredError: (await import('$lib/mature-charge')).MatureAckRequiredError,
}));

const { GET, POST } = await import('./+server');

const post = (body: unknown) =>
  POST({
    locals: { user: { id: 1 } },
    request: new Request('http://x/api/continue-training', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof POST>[0]);

describe('GET /api/continue-training', () => {
  it('prices against the currencies on the query string', async () => {
    continueTrainingWhatIf.mockResolvedValueOnce({ cost: 1400 });
    const url = new URL(
      'http://x/api/continue-training?id=wf-1&fromEpoch=10&addEpochs=5&currencies=blue&currencies=green'
    );
    await GET({ locals: { user: { id: 1 } }, url } as unknown as Parameters<typeof GET>[0]);
    expect(continueTrainingWhatIf.mock.calls[0]![2]).toMatchObject({
      workflowId: 'wf-1',
      currencies: ['blue', 'green'],
    });
  });
});

describe('POST /api/continue-training', () => {
  const body = { workflowId: 'wf-1', fromEpoch: 10, addEpochs: 5, currencies: ['blue'] };

  it('passes the mature confirm through only when it is literally true', async () => {
    continueTraining.mockResolvedValue('wf-2');
    await post({ ...body, matureAck: true });
    await post({ ...body, matureAck: 'true' });
    await post(body);
    expect(continueTraining.mock.calls.map((c) => c[2].matureAck)).toEqual([true, false, false]);
  });

  it('answers 409 with the reason when the mature confirm is missing', async () => {
    const refusal = new MatureAckRequiredError(3);
    continueTraining.mockRejectedValueOnce(refusal);
    await expect(post(body)).rejects.toMatchObject({
      status: 409,
      body: { message: refusal.message, matureCount: 3 },
    });
  });
});
