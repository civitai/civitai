import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getWorkflow = vi.fn();
vi.mock('@civitai/orchestration-client', () => ({
  createCivitaiClient: () => ({}),
  getWorkflow: (...args: unknown[]) => getWorkflow(...args),
}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));

const { GET } = await import('./+server');

const BLOB = 'https://orch.test/v2/consumer/blobs/';
const trainingRun = {
  id: 'wf-1',
  status: 'succeeded',
  createdAt: '2026-09-01T00:00:00.000Z',
  tags: ['civitai', 'training'],
  metadata: { name: 'Run', media: 'image', cardType: 'sdxl' },
  steps: [
    {
      $type: 'training',
      input: {
        engine: 'ai-toolkit',
        ecosystem: 'sdxl',
        trainingData: { type: 'blobs', items: [{ air: `${BLOB}ds-1.png`, caption: '' }] },
      },
      output: {
        epochs: [
          { epochNumber: 1, model: { id: 'weights-key', url: 'https://x/m', available: true } },
        ],
      },
    },
  ],
};
const editGeneration = {
  id: 'gen-1',
  status: 'succeeded',
  tags: ['civitai', 'gen', 'img', 'img2img:edit'],
  steps: [
    {
      $type: 'imageGen',
      input: { images: [`${BLOB}start-1.png?sig=1`, `${BLOB}weights-key.safetensors`] },
    },
  ],
};

const otherGeneration = { ...editGeneration, id: 'gen-2', tags: ['civitai', 'gen', 'img'] };

const upstream = vi.fn(
  async () => new Response('bytes', { headers: { 'content-type': 'image/png' } })
);
let nextUser = 1;
const get = (query: string, userId = nextUser++) =>
  GET({
    locals: { user: { id: userId } },
    url: new URL(`http://x/api/dataset-blob?${query}`),
    fetch: upstream,
  } as unknown as Parameters<typeof GET>[0]);

const status = async (run: () => Response | Promise<Response>) => {
  try {
    return (await run()).status;
  } catch (err) {
    return (err as { status: number }).status;
  }
};

beforeEach(() => {
  vi.stubEnv('ORCHESTRATOR_ENDPOINT', 'https://orch.test');
  getWorkflow.mockImplementation(async ({ path }: { path: { workflowId: string } }) =>
    path.workflowId === 'wf-1'
      ? { data: trainingRun }
      : path.workflowId === 'gen-1'
      ? { data: editGeneration }
      : path.workflowId === 'gen-2'
      ? { data: otherGeneration }
      : { data: undefined, error: { status: 404 } }
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  upstream.mockClear();
  getWorkflow.mockReset();
});

describe('GET /api/dataset-blob', () => {
  it("serves a blob from the run's own dataset", async () => {
    expect(await (await get('air=ds-1.png&workflowId=wf-1')).text()).toBe('bytes');
  });

  it("serves an image edit's starting image, for the edit-pair picker", async () => {
    const air = encodeURIComponent(`${BLOB}start-1.png?sig=1`);
    expect(await (await get(`air=${air}&workflowId=gen-1`)).text()).toBe('bytes');
  });

  it.each([
    [
      "the run's own weights",
      'air=urn:air:sdxl:lora:orchestrator:blob@weights-key&workflowId=wf-1',
    ],
    [
      'a non-image blob named as an edit input',
      `air=${encodeURIComponent(`${BLOB}weights-key.safetensors`)}&workflowId=gen-1`,
    ],
    ['a run the caller cannot read', 'air=ds-1.png&workflowId=someone-else'],
    [
      "an input of a workflow that isn't an image edit",
      `air=${encodeURIComponent(`${BLOB}start-1.png?sig=1`)}&workflowId=gen-2`,
    ],
    ['no run at all', 'air=ds-1.png'],
  ])('refuses %s without fetching it', async (_label, query) => {
    expect([400, 404]).toContain(await status(() => get(query)));
    expect(upstream).not.toHaveBeenCalled();
  });

  it('fails closed when the run cannot be read', async () => {
    getWorkflow.mockResolvedValue({ data: undefined, error: { status: 503 } });
    expect(await status(() => get('air=ds-1.png&workflowId=wf-1'))).toBe(502);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("never answers one user from another user's read of the same run", async () => {
    expect(await (await get('air=ds-1.png&workflowId=wf-1', 900)).text()).toBe('bytes');
    getWorkflow.mockResolvedValue({ data: undefined, error: { status: 404 } });
    expect(await status(() => get('air=ds-1.png&workflowId=wf-1', 901))).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("reuses a user's own read of the run for the rest of the grid", async () => {
    await get('air=ds-1.png&workflowId=wf-1', 902);
    await get('air=ds-1.png&workflowId=wf-1', 902);
    expect(getWorkflow).toHaveBeenCalledTimes(1);
  });

  it('shares one read of the run across a grid asked for at once', async () => {
    const grid = Array.from({ length: 5 }, () => get('air=ds-1.png&workflowId=wf-1', 903));
    await Promise.all(grid);
    expect(getWorkflow).toHaveBeenCalledTimes(1);
  });

  it('reads the run again after a failed read', async () => {
    getWorkflow.mockResolvedValueOnce({ data: undefined, error: { status: 503 } });
    expect(await status(() => get('air=ds-1.png&workflowId=wf-1', 904))).toBe(502);
    expect(await (await get('air=ds-1.png&workflowId=wf-1', 904)).text()).toBe('bytes');
  });

  it('reads the run again after an empty answer', async () => {
    getWorkflow.mockResolvedValueOnce({ data: { ...trainingRun, steps: [] } });
    expect(await status(() => get('air=ds-1.png&workflowId=wf-1', 905))).toBe(404);
    expect(await (await get('air=ds-1.png&workflowId=wf-1', 905)).text()).toBe('bytes');
  });
});
