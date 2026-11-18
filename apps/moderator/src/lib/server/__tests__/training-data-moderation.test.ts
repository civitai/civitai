import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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

// The SDK's generated enum, as the main app's webhook imports it; the root module is mocked above.
const { WorkflowStatus } = await import(
  '@civitai/orchestration-client/dist/generated/types.gen.js'
);
/** The body schema of src/pages/api/webhooks/resource-training-v2/[modelVersionId].ts. */
const webhookSchema = z.object({ workflowId: z.string(), status: z.enum(WorkflowStatus) });

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

  // The manager API writes PascalCase (`Processing`, `Succeeded`); the main app's
  // resource-training-v2 webhook parses `status` with z.enum(WorkflowStatus), the SDK's camelCase.
  // Sent as is, every approval's webhook is a 400 after the gate is already released.
  it.each(Object.values(WorkflowStatus))(
    'posts a manager %s status as the webhook schema accepts it',
    async (status) => {
      serve(204);
      const pascal = status[0].toUpperCase() + status.slice(1);
      managerRead = () => Response.json(managerWorkflow('UnderReview', pascal));

      const result = await moderateTrainingData({
        modelVersionId: VERSION,
        approve: true,
        moderatorId: MODERATOR,
      });

      expect(result).toEqual({ ok: true });
      const [body] = webhookBodies();
      expect(webhookSchema.safeParse(body).success).toBe(true);
      expect(body).toEqual({ workflowId: WF, status });
    }
  );

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

  it('refuses a ruled run of another version as not belonging, not as already ruled', async () => {
    serve(204);
    managerRead = () =>
      Response.json({ ...managerWorkflow('Approved', 'Succeeded'), tags: ['modelVersion:43'] });

    const result = await moderateTrainingData({
      modelVersionId: VERSION,
      approve: true,
      moderatorId: MODERATOR,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(`does not belong to model version ${VERSION}`);
    expect(gateCalls()).toHaveLength(0);
  });

  it("refuses a gate whose training file points at another version's run, releasing nothing", async () => {
    serve(204);
    managerRead = () =>
      Response.json({ ...managerWorkflow('UnderReview'), tags: ['modelVersion:43'] });

    const result = await moderateTrainingData({
      modelVersionId: VERSION,
      approve: true,
      moderatorId: MODERATOR,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(`does not belong to model version ${VERSION}`);
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
