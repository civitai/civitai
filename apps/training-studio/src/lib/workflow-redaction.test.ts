import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getTrainingWorkflow,
  listTrainingWorkflows,
  queryRecentWorkflows,
  readWorkflow,
  type OrchestratorClient,
} from './orchestrator-core';
import { pollEditImage } from './edit-helpers-core';

const getWorkflow = vi.fn();
const queryWorkflows = vi.fn();
// Hand-listed: the client's dist imports a directory, which Node's ESM loader refuses.
vi.mock('@civitai/orchestration-client', () => ({
  getWorkflow: (...args: unknown[]) => getWorkflow(...args),
  queryWorkflows: (...args: unknown[]) => queryWorkflows(...args),
}));

const MARKER = 'callback-marker-7f3a';
const client = {} as OrchestratorClient;

const trainingWorkflow = () => ({
  id: 'wf-1',
  status: 'succeeded',
  createdAt: '2026-09-01T00:00:00.000Z',
  tags: ['civitai', 'training'],
  metadata: { name: 'My Char', media: 'image', loraType: 'character', cardType: 'sdxl' },
  callbacks: [{ url: `https://hooks.example/cb?token=${MARKER}`, type: ['workflow:*'] }],
  steps: [
    {
      $type: 'training',
      status: 'succeeded',
      input: {
        engine: 'ai-toolkit',
        ecosystem: 'sdxl',
        epochs: 1,
        trainingData: { type: 'blobs', items: [{ air: 'https://x/blobs/A.png', caption: 'c' }] },
        samples: { prompts: ['a photo'] },
      },
      output: {
        epochs: [
          {
            epochNumber: 1,
            model: { id: 'M1.safetensors', url: 'https://x/m1', available: true },
            samples: [{ id: 'S1.png', url: 'https://x/s1', available: true }],
          },
        ],
      },
    },
  ],
});

const editWorkflow = () => ({
  id: 'wf-edit',
  status: 'succeeded',
  callbacks: [{ url: `https://hooks.example/cb?token=${MARKER}`, type: ['workflow:*'] }],
  steps: [
    {
      $type: 'imageGen',
      status: 'succeeded',
      output: { images: [{ id: 'img-1', url: 'https://x/img-1', available: true }] },
    },
  ],
});

beforeEach(() => {
  getWorkflow.mockReset();
  queryWorkflows.mockReset();
});

describe('workflow reads drop callbacks', () => {
  it('readWorkflow returns the workflow without callbacks, keeping every other field', async () => {
    getWorkflow.mockResolvedValueOnce({ data: trainingWorkflow() });
    const { data } = await readWorkflow(client, 'wf-1');
    expect(data).toBeDefined();
    expect(data).not.toHaveProperty('callbacks');
    expect(JSON.stringify(data)).not.toContain(MARKER);
    const { callbacks: _callbacks, ...rest } = trainingWorkflow();
    expect(data).toEqual(rest);
  });

  it('readWorkflow passes a failed read through unchanged', async () => {
    getWorkflow.mockResolvedValueOnce({ data: undefined, error: { status: 404 } });
    const result = await readWorkflow(client, 'missing');
    expect(result.data).toBeUndefined();
    expect(result.error).toEqual({ status: 404 });
  });

  it('queryRecentWorkflows returns workflows without callbacks', async () => {
    queryWorkflows.mockResolvedValueOnce({ data: { items: [trainingWorkflow(), editWorkflow()] } });
    const items = await queryRecentWorkflows(client, ['civitai']);
    expect(items).toHaveLength(2);
    for (const item of items) expect(item).not.toHaveProperty('callbacks');
    expect(JSON.stringify(items)).not.toContain(MARKER);
    expect(items.map((w) => w.id)).toEqual(['wf-1', 'wf-edit']);
  });
});

// What the shell's routes and loads return to the browser.
describe('browser-facing payloads carry no callback data', () => {
  it('the run list', async () => {
    queryWorkflows.mockResolvedValueOnce({ data: { items: [trainingWorkflow()] } });
    const rows = await listTrainingWorkflows(client);
    expect(rows.map((r) => r.workflowId)).toEqual(['wf-1']);
    expect(JSON.stringify(rows)).not.toContain(MARKER);
  });

  it('the run detail', async () => {
    getWorkflow.mockResolvedValueOnce({ data: trainingWorkflow() });
    const detail = await getTrainingWorkflow(client, 'wf-1');
    expect(detail?.workflowId).toBe('wf-1');
    expect(detail?.epochs).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toContain(MARKER);
  });

  it('the edit-image poll', async () => {
    getWorkflow.mockResolvedValueOnce({ data: editWorkflow() });
    const poll = await pollEditImage(client, 'wf-edit');
    expect(poll.options.map((o) => o.blobId)).toEqual(['img-1']);
    expect(JSON.stringify(poll)).not.toContain(MARKER);
  });
});
