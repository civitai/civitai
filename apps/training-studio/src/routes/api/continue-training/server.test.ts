import { describe, expect, it, vi } from 'vitest';
import { MatureAckRequiredError } from '$lib/mature-charge';
import { RunWithheldError } from '$lib/server/withheld';

const continueTrainingWhatIf = vi.fn();
const continueTraining = vi.fn();
// Empty: the route loads train-core only for its error class; the client's dist can't load under Node's ESM loader.
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
const assertNotWithheld = vi.fn(async (_cookie: string, _id: string) => undefined);
vi.mock('$lib/server/withheld', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/withheld')>()),
  assertNotWithheld: (cookie: string, id: string) => assertNotWithheld(cookie, id),
}));
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
    await GET({
      locals: { user: { id: 1 } },
      request: new Request('http://x'),
      url,
    } as unknown as Parameters<typeof GET>[0]);
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

describe('keep training from a withheld run', () => {
  it.each([
    [
      'the quote',
      () =>
        GET({
          locals: { user: { id: 1 } },
          request: new Request('http://x'),
          url: new URL('http://x/api/continue-training?id=wf-1&fromEpoch=1&addEpochs=1'),
        } as unknown as Parameters<typeof GET>[0]),
      continueTrainingWhatIf,
    ],
    [
      'the submit',
      () => post({ workflowId: 'wf-1', fromEpoch: 1, addEpochs: 1 }),
      continueTraining,
    ],
  ])('refuses %s before it reads the run', async (_label, run, core) => {
    core.mockClear();
    assertNotWithheld.mockRejectedValueOnce(new RunWithheldError());
    await expect(run()).rejects.toMatchObject({ status: 403 });
    expect(assertNotWithheld.mock.calls.at(-1)?.[1]).toBe('wf-1');
    expect(core).not.toHaveBeenCalled();
  });
});
