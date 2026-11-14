import { describe, expect, it, vi } from 'vitest';

const getRunDataset = vi.fn(async () => [{ air: 'ds-1.png', caption: 'c' }]);
const withheld = vi.fn(async (_asker: unknown, _ids: string[]) => new Set<string>());
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/orchestrator', () => ({ getRunDataset: () => getRunDataset() }));
vi.mock('$lib/server/model-status', () => ({
  mainAppWithheldRuns: (asker: unknown, ids: string[]) => withheld(asker, ids),
}));

const { GET } = await import('./+server');

const read = () =>
  GET({
    locals: { user: { id: 1 } },
    request: new Request('http://x', { headers: { cookie: 'civ-token=x' } }),
    url: new URL('http://x/api/run-dataset?id=wf-1'),
  } as unknown as Parameters<typeof GET>[0]);

describe('GET /api/run-dataset', () => {
  it("returns a clean run's dataset", async () => {
    expect(await (await read()).json()).toEqual([{ air: 'ds-1.png', caption: 'c' }]);
    expect(withheld).toHaveBeenCalledWith({ cookie: 'civ-token=x', userId: 1 }, ['wf-1']);
  });

  it("refuses a withheld run's dataset without reading it", async () => {
    getRunDataset.mockClear();
    withheld.mockImplementationOnce(async () => new Set(['wf-1']));
    await expect(read()).rejects.toMatchObject({ status: 403 });
    expect(getRunDataset).not.toHaveBeenCalled();
  });
});
