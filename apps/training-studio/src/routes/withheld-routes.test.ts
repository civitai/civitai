import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrainingDetail, TrainingRow } from '$lib/data/trainingRows';

// The four reads that hand epoch outputs to the browser, each through the withheld check.
const orch = vi.hoisted(() => ({ listTrainingWorkflows: vi.fn(), getTrainingWorkflow: vi.fn() }));
// The main app's answer.
const withheldRuns = vi.hoisted(() =>
  vi.fn(async (_asker: unknown, _ids: string[]) => new Set<string>())
);
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('$lib/server/orchestrator', () => orch);
vi.mock('$lib/server/orchestrator-token', () => ({ orchestratorToken: async () => 'token' }));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/train', () => ({ deleteTraining: vi.fn() }));
vi.mock('$lib/server/model-status', () => ({
  mainAppWithheldRuns: (asker: unknown, ids: string[]) => withheldRuns(asker, ids),
}));

const { load: listLoad } = await import('./+page.server');
const { load: detailLoad } = await import('./[id]/+page.server');
const { GET: runDetailGet } = await import('./api/run-detail/+server');
const { GET: trainingsGet } = await import('./api/trainings/+server');

const MARK = 'epoch-marker';
const COOKIE = 'civ-token=x';
const row = (workflowId: string) =>
  ({ workflowId, name: workflowId, sampleUrls: [`https://x/s?${MARK}`] } as unknown as TrainingRow);
const detail = {
  workflowId: 'wf-1',
  name: 'Run',
  traces: [{ epoch: 1, url: `https://x/t?${MARK}`, done: true }],
  liveTraceUrl: `https://x/t?${MARK}`,
  epochs: [
    {
      id: '1-0',
      number: 1,
      samples: [`https://x/s?${MARK}`],
      modelUrl: `https://x/m?${MARK}`,
      modelKey: `M-${MARK}`,
    },
  ],
} as unknown as TrainingDetail;

const event = (extra: Record<string, unknown> = {}) =>
  ({
    locals: { user: { id: 1, username: 'u', image: null }, devPreview: false },
    request: new Request('https://studio.example/', { headers: { cookie: COOKIE } }),
    url: new URL('https://studio.example/api/run-detail?id=wf-1'),
    params: { id: 'wf-1' },
    depends: () => undefined,
    ...extra,
  } as never);

beforeEach(() => {
  withheldRuns.mockReset();
  withheldRuns.mockImplementation(async () => new Set(['wf-1']));
  orch.listTrainingWorkflows.mockResolvedValue([row('wf-1'), row('wf-2')]);
  orch.getTrainingWorkflow.mockResolvedValue(detail);
});

const body = async (out: unknown) =>
  JSON.stringify(out instanceof Response ? await out.json() : out);

describe.each([
  ['the list load', () => listLoad(event())],
  ['GET /api/trainings', () => trainingsGet(event())],
])('%s', (_label, read) => {
  it('clears the samples of a withheld run only, asking once with the session', async () => {
    const out = (await body(await read())) as string;
    expect(out).not.toContain(`"wf-1","sampleUrls":["https`);
    expect(JSON.parse(out).rows ?? JSON.parse(out)).toEqual([
      expect.objectContaining({ workflowId: 'wf-1', sampleUrls: [] }),
      expect.objectContaining({ workflowId: 'wf-2', sampleUrls: [`https://x/s?${MARK}`] }),
    ]);
    expect(withheldRuns).toHaveBeenCalledTimes(1);
    expect(withheldRuns).toHaveBeenCalledWith({ cookie: COOKIE, userId: 1 }, ['wf-1', 'wf-2']);
  });
});

describe.each([
  ['the detail load', () => detailLoad(event())],
  ['GET /api/run-detail', () => runDetailGet(event())],
])('%s', (_label, read) => {
  it('hides every epoch output of a withheld run', async () => {
    expect(await body(await read())).not.toContain(MARK);
    expect(withheldRuns).toHaveBeenCalledWith({ cookie: COOKIE, userId: 1 }, ['wf-1']);
  });

  it('withholds a detail that comes back under another id than the one checked', async () => {
    withheldRuns.mockImplementation(async () => new Set());
    orch.getTrainingWorkflow.mockResolvedValue({ ...detail, workflowId: 'WF-1' });
    expect(await body(await read())).not.toContain(MARK);
  });

  it('keeps everything for a run that is not withheld', async () => {
    withheldRuns.mockImplementation(async () => new Set());
    expect(await body(await read())).toContain(`https://x/m?${MARK}`);
  });
});
