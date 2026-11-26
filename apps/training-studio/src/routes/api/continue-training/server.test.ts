import { describe, expect, it, vi } from 'vitest';
import { DatasetUnreadableError, MatureRepriceError } from '$lib/mature-charge';
import { RunWithheldError } from '$lib/server/withheld';

const continueTrainingWhatIf = vi.fn();
const continueTraining = vi.fn();
// Empty: the route loads train-core only for its error class; the client's dist can't load under Node's ESM loader.
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
const assertNotWithheld = vi.fn(async (_asker: unknown, _id: string) => undefined);
vi.mock('$lib/server/withheld', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/withheld')>()),
  assertNotWithheld: (asker: unknown, id: string) => assertNotWithheld(asker, id),
}));
vi.mock('$lib/server/text-check', () => ({
  textCheckCookie: () => null,
  throwTextCheckHttpError: () => undefined,
}));
const logToAxiom = vi.fn();
vi.mock('$lib/server/axiom', () => ({ logToAxiom }));
let kohyaAllowed = false;
vi.mock('$lib/server/flipt', () => ({
  isKohyaAllowed: async () => kohyaAllowed,
  flagVariant: async () => null,
}));
vi.mock('$lib/server/train', async () => ({
  continueTraining: (...args: unknown[]) => continueTraining(...args),
  continueTrainingWhatIf: (...args: unknown[]) => continueTrainingWhatIf(...args),
  MatureRepriceError: (await import('$lib/mature-charge')).MatureRepriceError,
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
    expect(continueTrainingWhatIf.mock.calls[0]![1]).toMatchObject({
      workflowId: 'wf-1',
      currencies: ['blue', 'green'],
    });
  });
});

describe('POST /api/continue-training', () => {
  const body = { workflowId: 'wf-1', fromEpoch: 10, addEpochs: 5, currencies: ['blue'] };

  it("passes the user's Kohya gate to the quote and the submit", async () => {
    continueTrainingWhatIf.mockResolvedValue({ cost: 1400 });
    continueTraining.mockResolvedValue('wf-2');
    const url = new URL('http://x/api/continue-training?id=wf-1&fromEpoch=10&addEpochs=5');
    for (const allowed of [true, false]) {
      kohyaAllowed = allowed;
      await GET({
        locals: { user: { id: 1 } },
        request: new Request('http://x'),
        url,
      } as unknown as Parameters<typeof GET>[0]);
      await post(body);
      expect(continueTrainingWhatIf.mock.calls.at(-1)![3]).toBe(allowed);
      expect(continueTraining.mock.calls.at(-1)![5]).toBe(allowed);
    }
  });
});

describe('POST /api/continue-training, mature reprice', () => {
  const body = { workflowId: 'wf-1', fromEpoch: 10, addEpochs: 5, currencies: ['blue', 'green'] };

  it('passes the quoted mature count to the submit, numbers only', async () => {
    continueTraining.mockResolvedValue('wf-2');
    await post({ ...body, matureCount: 2 });
    await post({ ...body, matureCount: '2' });
    expect(continueTraining.mock.calls.slice(-2).map((c) => c[2].quotedMatureCount)).toEqual([
      2,
      undefined,
    ]);
  });

  it('answers 409 with the count when the submit rates mature after a clean quote', async () => {
    const refusal = new MatureRepriceError(3);
    continueTraining.mockRejectedValueOnce(refusal);
    await expect(post(body)).rejects.toMatchObject({
      status: 409,
      body: { message: refusal.message, matureCount: 3 },
    });
  });

  it('answers 503 with the retry message and logs the count when source images cannot be read', async () => {
    const refusal = new DatasetUnreadableError(1);
    continueTraining.mockRejectedValueOnce(refusal);
    await expect(post(body)).rejects.toMatchObject({
      status: 503,
      body: { message: refusal.message },
    });
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'training-studio-dataset-unreadable',
        userId: 1,
        payload: { unreadable: 1 },
      })
    );
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
