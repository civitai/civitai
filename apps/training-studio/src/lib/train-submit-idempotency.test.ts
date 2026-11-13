import { beforeEach, describe, expect, it, vi } from 'vitest';

// A training submit spends Buzz. The orchestrator below is a ledger: every submit it receives
// creates (and would charge) a workflow, whatever it answers. The SDK is mocked at its function
// boundary, the way the rest of this app's suites mock it (its dist cannot be loaded by Node's ESM
// loader in a factory).

type Workflow = { id: string; tags: string[] };
let workflows: Workflow[] = [];
/** How the next submit answers AFTER creating its workflow: data, a 504, or a thrown network error. */
let nextAnswers: Array<'ok' | '504' | 'throw'> = [];
let queryFails = false;
/** Lookups fail once a workflow exists: the reconcile after a lost response is blind too. */
let queryFailsAfterSubmit = false;

const submitWorkflow = vi.fn(async ({ body }: { body: { tags: string[] } }) => {
  const workflow = { id: `wf-${workflows.length + 1}`, tags: body.tags };
  workflows.push(workflow);
  const answer = nextAnswers.shift() ?? 'ok';
  if (answer === 'throw') throw new TypeError('fetch failed');
  if (answer === '504') return { error: { detail: 'Gateway Timeout' }, response: { status: 504 } };
  return { data: { id: workflow.id }, response: { status: 200 } };
});
const queryWorkflows = vi.fn(async ({ query }: { query: { tags: string[] } }) => {
  if (queryFails || (queryFailsAfterSubmit && workflows.length > 0))
    return { error: { detail: 'unavailable' } };
  return { data: { items: workflows.filter((w) => query.tags.every((t) => w.tags.includes(t))) } };
});

vi.mock('@civitai/orchestration-client', () => ({
  Air: { isAir: () => false, stringify: () => 'air' },
  getResource: vi.fn(),
  getWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  headBlob: vi.fn(),
  submitWorkflow: (args: { body: { tags: string[] } }) => submitWorkflow(args),
  queryWorkflows: (args: { query: { tags: string[] } }) => queryWorkflows(args),
}));

const { submitTrainingBatch, TrainingSubmitError } = await import('./train-core');
type Run = Parameters<typeof submitTrainingBatch>[1] extends (infer R)[] | undefined ? R : never;

const client = {} as Parameters<typeof submitTrainingBatch>[0];
const checkText = async () => undefined;
const KEY = '0123456789abcdef0123456789abcdef0000';

const run = (submitKey?: string): Run => ({
  ecosystem: 'sdxl',
  steps: 2000,
  epochs: 10,
  unetLr: 5e-4,
  textEncoderLr: 5e-5,
  networkDim: 32,
  networkAlpha: 32,
  resolution: 1024,
  batchSize: 4,
  lrScheduler: 'cosine',
  optimizer: 'Adafactor',
  trigger: 'ohwx',
  items: [{ air: 'blob-1', caption: 'ohwx, 1girl' }],
  prompts: ['ohwx, a photo'],
  meta: { name: 'test' },
  ...(submitKey ? { submitKey } : {}),
});

beforeEach(() => {
  workflows = [];
  nextAnswers = [];
  queryFails = false;
  queryFailsAfterSubmit = false;
  vi.clearAllMocks();
});

describe('training submit after a lost response', () => {
  it('a submit that created its workflow and answered 504 returns that workflow, once', async () => {
    nextAnswers = ['504'];
    await expect(submitTrainingBatch(client, [run(KEY)], { checkText })).resolves.toEqual({
      workflowIds: ['wf-1'],
    });
    expect(workflows).toHaveLength(1);
  });

  it('a retry of the same batch after the response never arrived submits nothing and returns the first run', async () => {
    nextAnswers = ['throw'];
    queryFailsAfterSubmit = true; // the reconcile after the lost response cannot see it either
    await expect(submitTrainingBatch(client, [run(KEY)], { checkText })).rejects.toThrow();
    expect(workflows).toHaveLength(1);

    queryFailsAfterSubmit = false;
    await expect(submitTrainingBatch(client, [run(KEY)], { checkText })).resolves.toEqual({
      workflowIds: ['wf-1'],
    });
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    expect(workflows).toHaveLength(1);
  });

  it('starts nothing when it cannot check whether the batch already started', async () => {
    queryFails = true;
    await expect(submitTrainingBatch(client, [run(KEY)], { checkText })).rejects.toBeInstanceOf(
      TrainingSubmitError
    );
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('bounds the submit with an abort signal', async () => {
    await submitTrainingBatch(client, [run(KEY)], { checkText });
    expect(submitWorkflow.mock.calls[0]![0]).toHaveProperty('signal');
    expect((submitWorkflow.mock.calls[0]![0] as { signal?: unknown }).signal).toBeInstanceOf(
      AbortSignal
    );
  });

  it('a different batch key is a different run', async () => {
    await submitTrainingBatch(client, [run(KEY)], { checkText });
    await submitTrainingBatch(client, [run(`${KEY.slice(0, -1)}1`)], { checkText });
    expect(workflows).toHaveLength(2);
  });
});
