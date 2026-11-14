import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getRunDataset = vi.fn();
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/orchestrator', () => ({
  getRunDataset: (...args: unknown[]) => getRunDataset(...args),
}));

const { GET } = await import('./+server');

const upstream = vi.fn(
  async () => new Response('bytes', { headers: { 'content-type': 'image/png' } })
);
let user = 1;
const get = (query: string) =>
  GET({
    locals: { user: { id: user++ } },
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
  getRunDataset.mockResolvedValue([
    { air: 'https://orch.test/v2/consumer/blobs/ds-1.png', caption: '' },
  ]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  upstream.mockClear();
  getRunDataset.mockReset();
});

describe('GET /api/dataset-blob', () => {
  it("serves a blob from the run's own dataset", async () => {
    const res = await get('air=ds-1.png&workflowId=wf-1');
    expect(await res.text()).toBe('bytes');
    expect(getRunDataset).toHaveBeenCalledWith('token', 'wf-1');
  });

  it("refuses a blob that is not in the run's dataset, without fetching it", async () => {
    expect(
      await status(() => get('air=urn:air:sdxl:lora:orchestrator:blob@weights-key&workflowId=wf-1'))
    ).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses a request that names no run', async () => {
    expect(await status(() => get('air=ds-1.png'))).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses when the caller can't read the run", async () => {
    getRunDataset.mockResolvedValue([]);
    expect(await status(() => get('air=ds-1.png&workflowId=someone-else'))).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});
