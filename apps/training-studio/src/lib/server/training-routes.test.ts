import http from 'node:http';
import { getRequest } from '@sveltejs/kit/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The two Studio routes that charge Buzz: how a trigger word verdict reaches the browser, and that a
// signed-in user's session is what the check is sent with.
const train = vi.hoisted(() => ({
  submitTrainingBatch: vi.fn(),
  continueTraining: vi.fn(),
  continueTrainingWhatIf: vi.fn(),
  MatureRepriceError: class extends Error {},
}));
vi.mock('$lib/server/train', () => train);
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/withheld', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/withheld')>()),
  assertNotWithheld: async () => undefined,
}));
// The routes load train-core only for its error classes; the real client's dist cannot load under
// Node's ESM loader (see train-core.test.ts).
vi.mock('@civitai/orchestration-client', () => ({}));

import { POST as trainPost } from '../../routes/api/train/+server';
import { POST as continuePost } from '../../routes/api/continue-training/+server';
import { TrainingTextCheckError, TrainingTextRefusedError } from '$lib/training-text';
import { TrainingBatchValidationError } from '$lib/train-core';
import {
  FILES_PROCESSING_CODE,
  FILES_PROCESSING_MESSAGE,
  FilesProcessingError,
} from '$lib/files-processing';

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

  it('answers a run on a model that is down with 400 and the reason', async () => {
    submit.mockRejectedValue(
      new TrainingBatchValidationError('Krea 2 is temporarily unavailable for training.')
    );
    await expect(run()).rejects.toMatchObject({
      status: 400,
      body: { message: 'Krea 2 is temporarily unavailable for training.' },
    });
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

describe('POST /api/train refused while files are still processing', () => {
  it('answers 400 with the neutral message and a code the browser can match', async () => {
    train.submitTrainingBatch.mockReset().mockRejectedValue(new FilesProcessingError());
    await expect(trainPost(event({ runs: [] }))).rejects.toMatchObject({
      status: 400,
      body: { message: FILES_PROCESSING_MESSAGE, code: FILES_PROCESSING_CODE },
    });
  });
});

describe('POST /api/train with a checkpoint to continue from', () => {
  it('is refused before anything is submitted', async () => {
    train.submitTrainingBatch.mockReset();
    const status = await statusOf(() =>
      trainPost(event({ runs: [{ continueFrom: 'urn:air:sdxl:lora:orchestrator:blob@k' }] }))
    );
    expect(status).toBe(400);
    expect(train.submitTrainingBatch).not.toHaveBeenCalled();
  });
});

describe('POST /api/train with a body over the server limit', () => {
  // Through the adapter's own request conversion, which errors an over-limit body instead of refusing it.
  async function throughNode(bytes: number, raw?: string) {
    let outcome: unknown;
    const server = http.createServer(async (req, res) => {
      const request = await getRequest({
        request: req,
        base: 'http://localhost',
        bodySizeLimit: 1024,
      });
      outcome = await Promise.resolve()
        .then(() => trainPost({ locals: { user: { id: 7 }, devPreview: false }, request } as never))
        .catch((e: unknown) => e);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const body = raw ?? JSON.stringify({ runs: [], pad: 'x'.repeat(bytes) });
    await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return outcome;
  }

  it('answers 413 saying the dataset is too large, not that the batch is empty', async () => {
    train.submitTrainingBatch.mockReset();
    expect(await throughNode(4096)).toMatchObject({
      status: 413,
      body: { message: expect.stringContaining('too large') },
    });
    expect(train.submitTrainingBatch).not.toHaveBeenCalled();
  });

  it('control: a malformed body under the limit is not called too large', async () => {
    train.submitTrainingBatch.mockReset().mockResolvedValue({ workflowIds: ['w'], failure: null });
    expect(await throughNode(16, '{not json')).not.toMatchObject({ status: 413 });
    expect(train.submitTrainingBatch.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('control: a body under the limit reaches the submit', async () => {
    train.submitTrainingBatch.mockReset().mockResolvedValue({ workflowIds: ['w'], failure: null });
    await throughNode(16);
    expect(train.submitTrainingBatch).toHaveBeenCalledTimes(1);
  });
});
