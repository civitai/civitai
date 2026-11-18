import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A ruling on a model version's training data is the moderator's only record of having made it, so
 * each released gate must leave exactly one activity row — and a refused one none.
 */

process.env.ORCHESTRATOR_ENDPOINT = 'https://orchestrator.example/';
process.env.ORCHESTRATOR_ACCESS_TOKEN = 'test-token';
process.env.WEBHOOK_TOKEN = 'hook-token';
process.env.CIVITAI_WEBHOOK_URL = 'https://civitai.example';

const recordModActivity = vi.fn();
const fileRows = vi.fn(async (): Promise<unknown[]> => []);

const chain: object = new Proxy(
  {},
  {
    get: (_, prop) => (prop === 'then' ? undefined : prop === 'execute' ? fileRows : () => chain),
  }
);

vi.mock('@civitai/orchestration-client', () => ({
  getWorkflow: vi.fn(),
  createCivitaiClient: vi.fn(),
}));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: chain }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({ $query: vi.fn() }) }));
vi.mock('$lib/server/mod-activity', () => ({ recordModActivity }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: vi.fn(async () => {}) }));
vi.mock('$lib/server/users.service', () => ({ usersByIds: vi.fn(async () => new Map()) }));
vi.mock('$lib/server/search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('$lib/server/user-actions.service', () => ({ callModEndpoint: vi.fn() }));

const { moderateTrainingData, getTrainingReviewQueue, invalidateTrainingReviewQueue } =
  await import('../training-moderation.service');

const VERSION = 42;
const MODERATOR = 7;
const WF = '9-20261005123456789-abcd';

const fetchMock = vi.fn();
const gateCalls = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/moderation-gate'));
const webhookBodies = () =>
  fetchMock.mock.calls
    .filter(([u]) => String(u).startsWith('https://civitai.example'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

/** The manager API's shape, PascalCase enums included. */
const managerWorkflow = (moderationStatus: string, status = 'Processing') => ({
  id: WF,
  status,
  tags: [`modelVersion:${VERSION}`],
  steps: [{ $type: 'training', status, output: { moderationStatus } }],
});
let managerRead: () => Response;

function serve(gateStatus: number) {
  fetchMock.mockImplementation(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/moderation-gate')) return new Response(null, { status: gateStatus });
    if (url.includes(`/v1/manager/workflows/${WF}`)) return managerRead();
    return new Response(null, { status: 200 });
  });
}

beforeEach(() => {
  invalidateTrainingReviewQueue();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  recordModActivity.mockReset();
  fileRows.mockResolvedValue([{ id: 1, metadata: { trainingResults: { workflowId: WF } } }]);
  managerRead = () => Response.json(managerWorkflow('UnderReview'));
});

describe('moderateTrainingData', () => {
  it.each([
    [true, 'trainingData:approve'],
    [false, 'trainingData:deny'],
  ])('approve=%s records exactly one %s row', async (approve, activity) => {
    serve(204);

    const result = await moderateTrainingData({
      modelVersionId: VERSION,
      approve,
      moderatorId: MODERATOR,
    });

    expect(result).toEqual({ ok: true });
    expect(gateCalls()).toHaveLength(1);
    expect(recordModActivity).toHaveBeenCalledExactlyOnceWith({
      userId: MODERATOR,
      entityType: 'modelVersion',
      entityId: VERSION,
      activity,
    });
  });

  it("posts the webhook the camelCase status it accepts, not the manager API's PascalCase", async () => {
    serve(204);
    await moderateTrainingData({ modelVersionId: VERSION, approve: true, moderatorId: MODERATOR });
    expect(webhookBodies()).toEqual([{ workflowId: WF, status: 'processing' }]);
  });

  it('refuses a gate the orchestrator reports already ruled, releasing nothing', async () => {
    serve(204);
    managerRead = () => Response.json(managerWorkflow('Approved', 'Succeeded'));

    const result = await moderateTrainingData({
      modelVersionId: VERSION,
      approve: true,
      moderatorId: MODERATOR,
    });

    expect(result).toEqual({
      ok: false,
      error: 'The gate is not under review (run: succeeded, gate: approved). Nothing was changed.',
    });
    expect(gateCalls()).toHaveLength(0);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  // Fail-open: only a reading that says closed refuses. The release refuses a closed gate itself.
  it('releases the gate when the run answered in a shape it cannot read', async () => {
    serve(204);
    managerRead = () => Response.json({ ...managerWorkflow('UnderReview'), steps: [] });

    const result = await moderateTrainingData({
      modelVersionId: VERSION,
      approve: true,
      moderatorId: MODERATOR,
    });

    expect(result).toEqual({ ok: true });
    expect(gateCalls()).toHaveLength(1);
  });

  it('records nothing when the orchestrator refuses the gate', async () => {
    serve(500);

    const result = await moderateTrainingData({
      modelVersionId: VERSION,
      approve: false,
      moderatorId: MODERATOR,
    });

    expect(result.ok).toBe(false);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('clears the review queue after the webhook, not only before it', async () => {
    // An empty Paused list: one db read per build, and a whole build that is cached.
    const emptyBuild = () => {
      fileRows.mockResolvedValueOnce([]);
      return getTrainingReviewQueue();
    };
    let midRuling: Promise<unknown> | undefined;
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/moderation-gate')) return new Response(null, { status: 204 });
      if (url.includes('/v1/manager/workflows/')) return managerRead();
      // The webhook: the version is still Paused while it is in flight.
      if (url.startsWith('https://civitai.example')) midRuling ??= emptyBuild();
      return new Response(null, { status: 200 });
    });

    await moderateTrainingData({ modelVersionId: VERSION, approve: true, moderatorId: MODERATOR });
    expect(midRuling).toBeDefined();
    await midRuling;
    const before = fileRows.mock.calls.length;
    await emptyBuild();
    expect(fileRows.mock.calls.length).toBe(before + 1);
  });
});
