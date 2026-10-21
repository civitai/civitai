import { beforeEach, describe, expect, it, vi } from 'vitest';

// The two Studio routes that charge Buzz: how a trigger word verdict reaches the browser, and that a
// signed-in user's session is what the check is sent with.
const train = vi.hoisted(() => ({
  submitTrainingBatch: vi.fn(),
  continueTraining: vi.fn(),
  continueTrainingWhatIf: vi.fn(),
}));
vi.mock('$lib/server/train', () => train);
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
// The routes load train-core only for its error classes; the real client's dist cannot load under
// Node's ESM loader (see train-core.test.ts).
vi.mock('@civitai/orchestration-client', () => ({}));

import { POST as trainPost } from '../../routes/api/train/+server';
import { POST as continuePost } from '../../routes/api/continue-training/+server';
import { TrainingTextCheckError, TrainingTextRefusedError } from '$lib/training-text';

function event(body: unknown) {
  return {
    locals: { user: { id: 7 }, devPreview: false },
    request: new Request('https://studio.example/api', {
      method: 'POST',
      headers: { cookie: 'civ-token=x', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never;
}

const routes = [
  ['train', () => trainPost(event({ runs: [] })), train.submitTrainingBatch, 3],
  [
    'continue-training',
    () => continuePost(event({ workflowId: 'wf', fromEpoch: 1, addEpochs: 1 })),
    train.continueTraining,
    3,
  ],
] as const;

/** The HTTP status a route answered with, whether it returned or threw an HttpError. */
async function statusOf(run: () => Response | Promise<Response>) {
  try {
    return (await run()).status;
  } catch (err) {
    return (err as { status: number }).status;
  }
}

describe.each(routes)('POST /api/%s', (_name, run, submit, cookieArg) => {
  beforeEach(() => {
    train.submitTrainingBatch.mockReset().mockResolvedValue({ workflowIds: ['wf'] });
    train.continueTraining.mockReset().mockResolvedValue('wf');
  });

  it("sends the check with the caller's session cookie", async () => {
    await run();
    expect(submit.mock.calls[0][cookieArg]).toBe('civ-token=x');
  });

  it('answers a refused trigger word with 400 and its reason', async () => {
    submit.mockRejectedValue(new TrainingTextRefusedError('blocked: x'));
    await expect(run()).rejects.toMatchObject({ status: 400, body: { message: 'blocked: x' } });
  });

  it.each([
    [401, 401],
    [403, 403],
    [503, 502],
    [undefined, 502],
  ])('answers a check that failed with %s as %i', async (from, to) => {
    submit.mockRejectedValue(new TrainingTextCheckError('failed', from));
    expect(await statusOf(run)).toBe(to);
  });
});
