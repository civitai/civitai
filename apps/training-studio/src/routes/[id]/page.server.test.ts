import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getTrainingWorkflow = vi.fn();
vi.mock('$lib/server/orchestrator-token', () => ({ orchestratorToken: async () => 'token' }));
vi.mock('$lib/server/orchestrator', () => ({
  getTrainingWorkflow: (...args: unknown[]) => getTrainingWorkflow(...args),
}));

const { load } = await import('./+page.server');

const mainApp = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

async function loadDetail() {
  const event = {
    locals: { user: { id: 1, username: 'u' } },
    params: { id: 'wf-1' },
    depends: vi.fn(),
    request: new Request('http://studio/wf-1', { headers: { cookie: 'session=abc' } }),
  };
  const data = (await load(event as unknown as Parameters<typeof load>[0])) as {
    detail: { modelId?: number };
  };
  return data.detail;
}

beforeEach(() => {
  vi.stubEnv('CIVITAI_URL', 'https://civitai.test');
  vi.stubGlobal('fetch', mainApp);
  getTrainingWorkflow.mockResolvedValue({ workflowId: 'wf-1', modelId: 77 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mainApp.mockReset();
});

describe('/[id] load: the run’s draft model link', () => {
  it('drops the modelId of a draft the main app reports deleted, so the page offers Publish', async () => {
    mainApp.mockResolvedValue(Response.json({ live: false }));
    expect((await loadDetail()).modelId).toBeUndefined();
    const [url, init] = mainApp.mock.calls[0]!;
    expect(url).toBe('https://civitai.test/api/training-studio/model-status?id=77');
    expect(new Headers(init.headers).get('cookie')).toBe('session=abc');
  });

  it('keeps the modelId of a live draft', async () => {
    mainApp.mockResolvedValue(Response.json({ live: true }));
    expect((await loadDetail()).modelId).toBe(77);
  });

  // Decision: an unreachable main app must not hide a real draft. Don't make this fail closed.
  it('keeps the link when the main app gives no answer', async () => {
    mainApp.mockResolvedValue(new Response('down', { status: 503 }));
    expect((await loadDetail()).modelId).toBe(77);
  });

  it('asks nothing for a run with no model', async () => {
    getTrainingWorkflow.mockResolvedValue({ workflowId: 'wf-1' });
    await loadDetail();
    expect(mainApp).not.toHaveBeenCalled();
  });
});
