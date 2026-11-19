import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const env = vi.hoisted(() => ({
  ORCHESTRATOR_ENDPOINT: 'https://orchestrator.test' as string | undefined,
  ORCHESTRATOR_ACCESS_TOKEN: 'svc' as string | undefined,
  ORCHESTRATOR_MODE: 'prod',
}));
vi.mock('~/env/server', () => ({ env }));
const updateWorkflow = vi.hoisted(() =>
  vi.fn(async (_args: { path: { workflowId: string } }) => ({ error: undefined as unknown }))
);
// The real tag constant, so a change to it fails here instead of silently cancelling nothing.
// generation.constants reads Scheduler members at load; any name will do.
vi.mock('@civitai/orchestration-client', () => ({
  createCivitaiClient: vi.fn((opts: unknown) => opts),
  updateWorkflow,
  Scheduler: new Proxy({}, { get: (_target, name) => String(name) }),
}));

const { cancelPendingWorkflows, CANCEL_PENDING_DEADLINE_MS } = await import(
  '~/server/services/orchestrator/cancel-pending-workflows'
);
const { createCivitaiClient } = await import('@civitai/orchestration-client');

type Listed = { id: string; status: string; tags?: string[] };
const gen = (id: string, status = 'scheduled', extra: string[] = []): Listed => ({
  id,
  status,
  tags: ['gen', 'img', ...extra],
});
let pages: { items: Listed[]; next?: string }[] = [];
const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
  const page = pages.shift() ?? { items: [] };
  return new Response(JSON.stringify(page), { status: 200 });
});

const cancelled = () => updateWorkflow.mock.calls.map(([args]) => args.path.workflowId);
const listUrl = (i: number) => new URL(String(fetchMock.mock.calls[i][0]));
const loggedNames = () =>
  loggingMock.logToAxiom.mock.calls.map(([entry]) => (entry as { name: string }).name);

beforeEach(() => {
  vi.clearAllMocks();
  pages = [];
  env.ORCHESTRATOR_ENDPOINT = 'https://orchestrator.test';
  env.ORCHESTRATOR_ACCESS_TOKEN = 'svc';
  updateWorkflow.mockReset();
  updateWorkflow.mockImplementation(async () => ({ error: undefined }));
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('cancelPendingWorkflows', () => {
  // A cancelled training is paid for and cannot be restarted, and an App Block run belongs to the
  // app: a mute, often an automatic one later lifted, must cancel site generations only.
  it('cancels pending site generations, never a training or an App Block run', async () => {
    pages = [
      {
        items: [
          gen('w-gen'),
          gen('w-running', 'processing'),
          gen('w-done', 'succeeded'),
          gen('w-block', 'scheduled', ['app-block', 'app-block:app:1']),
          { id: 'w-training', status: 'processing', tags: ['training', 'modelVersion:1'] },
          // An item without tags cannot be shown to be a site generation, so it is left alone.
          { id: 'w-untagged', status: 'scheduled' },
          { id: 'w-empty-tags', status: 'scheduled', tags: [] },
        ],
      },
    ];
    await cancelPendingWorkflows(42);
    expect(cancelled().sort()).toEqual(['w-gen', 'w-running']);
    // Listed for this account, by the generation tag, through the manager list.
    const url = listUrl(0);
    expect(url.pathname).toBe('/v1/manager/workflows');
    expect(url.searchParams.get('userId')).toBe('42');
    expect(url.searchParams.getAll('tags')).toEqual(['gen']);
  });

  // The service credential, not the account's own token: a mute with no cached token cancels too.
  it("lists and cancels with the service credential, needing no token of the account's", async () => {
    pages = [{ items: [gen('w-1')] }];
    await cancelPendingWorkflows(42);
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe(
      'Bearer svc'
    );
    expect(createCivitaiClient).toHaveBeenCalledWith(expect.objectContaining({ auth: 'svc' }));
    expect(cancelled()).toEqual(['w-1']);
  });

  it('follows the cursor, and stops at five pages and says so', async () => {
    pages = Array.from({ length: 10 }, (_, i) => ({ items: [gen(`w-${i}`)], next: `c${i}` }));
    await cancelPendingWorkflows(42);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(listUrl(1).searchParams.get('cursor')).toBe('c0');
    expect(cancelled()).toHaveLength(5);
    expect(loggedNames()).toContain('mute.cancel-workflows-list-truncated');
  });

  it('still cancels the first page when a later page fails', async () => {
    pages = [{ items: [gen('w-1')], next: 'c1' }];
    fetchMock
      .mockImplementationOnce(async () => new Response(JSON.stringify(pages.shift())))
      .mockImplementationOnce(async () => new Response(null, { status: 503 }));
    await cancelPendingWorkflows(42);
    expect(cancelled()).toEqual(['w-1']);
    expect(loggedNames()).toContain('mute.cancel-workflows-list-failed');
  });

  // A mute can list up to 500 generations; firing them all at once floods the orchestrator.
  it('runs at most ten cancels at a time, and still cancels them all', async () => {
    pages = [{ items: Array.from({ length: 20 }, (_, i) => gen(`w-${i}`)) }];
    let inFlight = 0;
    let peak = 0;
    updateWorkflow.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { error: undefined };
    });
    await cancelPendingWorkflows(42);
    expect(peak).toBe(10);
    expect(cancelled()).toHaveLength(20);
  });

  it('retries a failed cancel once, then logs the workflow id', async () => {
    pages = [{ items: [gen('w-flaky'), gen('w-stuck')] }];
    const seen = new Map<string, number>();
    updateWorkflow.mockImplementation(async ({ path }) => {
      const n = (seen.get(path.workflowId) ?? 0) + 1;
      seen.set(path.workflowId, n);
      return { error: path.workflowId === 'w-stuck' || n === 1 ? { status: 503 } : undefined };
    });
    await cancelPendingWorkflows(42);
    expect(cancelled().filter((id) => id === 'w-flaky')).toHaveLength(2);
    expect(cancelled().filter((id) => id === 'w-stuck')).toHaveLength(2);
    const failures = loggingMock.logToAxiom.mock.calls
      .map(([entry]) => entry as { name: string; workflowId?: string })
      .filter((entry) => entry.name === 'mute.cancel-workflow-failed');
    expect(failures.map((f) => f.workflowId)).toEqual(['w-stuck']);
  });

  it('returns after the deadline when the orchestrator hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    let settled = false;
    const done = cancelPendingWorkflows(42).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(CANCEL_PENDING_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await done;
  });

  it('never throws, and logs, when the orchestrator is not configured', async () => {
    env.ORCHESTRATOR_ACCESS_TOKEN = undefined;
    await expect(cancelPendingWorkflows(42)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggedNames()).toContain('mute.cancel-workflows-list-failed');
  });
});
