import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Workflow-only training runs (Training Studio, App Blocks) have no ModelVersion, so the run is
 * identified, attributed and ruled on purely from the orchestrator's workflow. These cases pin the
 * decisions that are silent when wrong: whose run it is, whether it may be ruled on HERE, whether a
 * ruling actually took, and what the queue lists when the orchestrator cannot be asked.
 *
 * Fixture shape follows the manager API, which writes enums PascalCase (`UnderReview`).
 */

process.env.ORCHESTRATOR_ENDPOINT = 'https://orchestrator.example/';
process.env.ORCHESTRATOR_ACCESS_TOKEN = 'test-token';

const recordModActivity = vi.fn();
const logToAxiom = vi.fn(async () => {});
const usersByIds = vi.fn(async () => new Map<number, { username: string | null }>());
const chQuery = vi.fn();

// The SDK's dist does not load under Node's ESM resolver (a directory import), and the workflow-only
// path does not use it — it reads the manager API with plain fetch, which is what these cases stub.
vi.mock('@civitai/client', () => ({ getWorkflow: vi.fn(), createCivitaiClient: vi.fn() }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({ $query: chQuery }) }));
vi.mock('$lib/server/mod-activity', () => ({ recordModActivity }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom }));
vi.mock('$lib/server/users.service', () => ({ usersByIds }));
vi.mock('$lib/server/search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('$lib/server/user-actions.service', () => ({ callModEndpoint: vi.fn() }));

const {
  parseWorkflowId,
  moderateTrainingWorkflow,
  getPendingWorkflowGates,
  getTrainingWorkflowDetail,
  resolveTrainingWorkflowBlob,
  clearTrainingWorkflowBlobCache,
} = await import('../training-moderation.service');
const { releaseModerationGate } = await import('../orchestrator');

const OWNER = 42;
const WF = `${OWNER}-20261005120000123-abcd`;
const KEY_A = `${'a'.repeat(32)}.png`;
const KEY_B = `${'b'.repeat(32)}.mp4`;

type Fixture = {
  id?: string;
  moderationStatus?: string;
  tags?: string[];
  stepType?: string;
  metadata?: Record<string, unknown>;
  items?: unknown[];
};

const workflow = (over: Fixture = {}) => ({
  id: over.id ?? WF,
  status: 'Processing',
  createdAt: '2026-10-05T12:00:00.123Z',
  tags: over.tags ?? ['civitai', 'training', 'app-block:my-app'],
  metadata: over.metadata ?? {},
  steps: [
    {
      $type: over.stepType ?? 'training',
      name: '0',
      status: 'Processing',
      startedAt: '2026-10-05T12:00:01Z',
      input: {
        engine: 'ai-toolkit',
        trainingData: {
          type: 'blobs',
          items: over.items ?? [
            { air: `urn:air:other:other:orchestrator:blob@${KEY_A}`, caption: 'a cat' },
            { air: `urn:air:other:other:orchestrator:blob@${KEY_B}` },
            { air: 'https://elsewhere.example/x.png', caption: 'not ours' },
          ],
        },
      },
      output: { moderationStatus: over.moderationStatus ?? 'UnderReview', epochs: [] },
    },
  ],
});

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
const fetchMock = vi.fn();
let route: Route;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Serve successive manager reads of WF from `reads`, holding the last one. */
function orchestrator(
  reads: unknown[],
  gate: () => Response = () => new Response(null, { status: 204 })
) {
  let i = 0;
  route = (url, init) => {
    if (url.pathname.endsWith('/moderation-gate') && init?.method === 'POST') return gate();
    if (url.pathname === `/v1/manager/workflows/${WF}`) {
      const body = reads[Math.min(i++, reads.length - 1)];
      return body instanceof Response ? body : json(body);
    }
    return new Response(null, { status: 599 });
  };
}

const gateCalls = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/moderation-gate'));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((input: string | URL, init?: RequestInit) =>
    route(new URL(String(input)), init)
  );
  vi.stubGlobal('fetch', fetchMock);
  recordModActivity.mockReset();
  logToAxiom.mockClear();
  usersByIds.mockClear();
  chQuery.mockReset();
  clearTrainingWorkflowBlobCache();
});
afterEach(() => vi.unstubAllGlobals());

const rule = (approve: boolean, extra: { message?: string; workflowId?: string } = {}) =>
  moderateTrainingWorkflow(
    { workflowId: extra.workflowId ?? WF, approve, message: extra.message, moderatorId: 7 },
    { recheckDelaysMs: [0, 0] }
  );

describe('parseWorkflowId', () => {
  it('reads the owner and submit instant from both id shapes in use', () => {
    expect(parseWorkflowId(WF)).toEqual({
      ownerId: 42,
      submittedAt: new Date('2026-10-05T12:00:00Z'),
    });
    // The older shape, with no suffix.
    expect(parseWorkflowId('5-20260818171734275')?.ownerId).toBe(5);
  });

  it.each([
    ['empty', ''],
    ['no owner', '-20261005120000123-abcd'],
    ['short timestamp', '42-2026100512-abcd'],
    ['path traversal', '42-20261005120000123/../../admin'],
    ['query smuggling', '42-20261005120000123?x=1'],
    ['owner beyond int4', '9999999999-20261005120000123'],
    ['owner zero', '0-20261005120000123'],
  ])('refuses %s', (_, raw) => {
    expect(parseWorkflowId(raw)).toBeNull();
  });
});

describe('moderateTrainingWorkflow', () => {
  it('refuses a malformed id without asking the orchestrator anything', async () => {
    orchestrator([workflow()]);
    const result = await rule(true, { workflowId: '42-not-a-workflow' });
    expect(result).toEqual({ ok: false, error: 'Not a workflow id. Nothing was changed.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a model-version run and points at the version route, before touching the gate', async () => {
    orchestrator([workflow({ tags: ['civitai', 'training', 'modelVersion:123'] })]);
    const result = await rule(true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('/audit/training-data/123');
    expect(gateCalls()).toHaveLength(0);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('refuses a run that is not under review', async () => {
    orchestrator([workflow({ moderationStatus: 'Approved' })]);
    const result = await rule(false);
    expect(result).toEqual({
      ok: false,
      error: 'This run is not awaiting review (moderation status: approved). Nothing was changed.',
    });
    expect(gateCalls()).toHaveLength(0);
  });

  it('refuses a workflow with no training step', async () => {
    orchestrator([workflow({ stepType: 'imageGen' })]);
    const result = await rule(true);
    expect(!result.ok && result.error).toContain('has no training step');
    expect(gateCalls()).toHaveLength(0);
  });

  it('attributes the ruling to the owner in the id, not to metadata claiming another user', async () => {
    orchestrator([
      workflow({ metadata: { userId: 999, ownerId: 999 }, tags: ['training', 'user:999'] }),
      workflow({ moderationStatus: 'Approved' }),
    ]);
    const result = await rule(true);
    expect(result).toEqual({ ok: true, moderationStatus: 'approved' });
    expect(recordModActivity).toHaveBeenCalledTimes(1);
    expect(recordModActivity).toHaveBeenCalledWith({
      userId: 7,
      entityType: 'user',
      entityId: OWNER,
      activity: 'trainingWorkflow:approve',
    });
  });

  it('reports "not applied" when the release is accepted but the run is still under review', async () => {
    orchestrator([workflow(), workflow(), workflow()]);
    const result = await rule(false);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('still under review — it was not applied yet');
    expect(gateCalls()).toHaveLength(1);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('surfaces a 404 from the gate release and records nothing', async () => {
    orchestrator([workflow()], () => new Response('No pending moderation gate', { status: 404 }));
    const result = await rule(true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('(404)');
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('records a deny as a deny once the run reads rejected', async () => {
    orchestrator([workflow(), workflow({ moderationStatus: 'Rejected' })]);
    const result = await rule(false, { message: '  dataset violates policy  ' });
    expect(result).toEqual({ ok: true, moderationStatus: 'rejected' });
    expect(recordModActivity).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: OWNER, activity: 'trainingWorkflow:deny' })
    );
    const [, init] = gateCalls()[0];
    expect(JSON.parse(String(init.body))).toEqual({
      approved: false,
      message: 'dataset violates policy',
    });
  });

  it('does not report success when the run ended in a state the ruling did not ask for', async () => {
    orchestrator([workflow(), workflow({ moderationStatus: 'Rejected' })]);
    const result = await rule(true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('not approved');
    expect(recordModActivity).not.toHaveBeenCalled();
  });
});

describe('releaseModerationGate', () => {
  it('forwards the message and encodes the id', async () => {
    route = () => new Response(null, { status: 204 });
    await releaseModerationGate('42-1 2', false, 'why');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'https://orchestrator.example/v1/manager/workflows/42-1%202/moderation-gate'
    );
    expect(JSON.parse(String(init.body))).toEqual({ approved: false, message: 'why' });
  });

  it('sends no message key when there is none', async () => {
    route = () => new Response(null, { status: 204 });
    await releaseModerationGate(WF, true);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ approved: true });
  });
});

describe('getPendingWorkflowGates', () => {
  const id = (owner: number, n: number) => `${owner}-2026100512000${n}123-abc${n}`;
  const A = id(1, 1); // under review, no tag → listed
  const B = id(2, 2); // refunded in the ledger → never read
  const C = id(3, 3); // training step already ended → never read
  const D = id(4, 4); // under review but a model-version run → dropped
  const E = id(5, 5); // finished → dropped
  const F = id(6, 6); // orchestrator no longer has it → dropped

  function ledger() {
    chQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("type = 'training'"))
        return [A, B, C, D, E, F, 'not-a-workflow-id'].map((workflowId) => ({ workflowId }));
      if (sql.includes("type = 'refund'")) return [{ workflowId: B }];
      if (sql.includes('orchestration.workflowSteps')) return [{ workflowId: C }];
      throw new Error(`unexpected query ${sql}`);
    });
  }

  it('lists only under-review, workflow-only runs, in ledger order', async () => {
    ledger();
    route = (url) => {
      const wf = decodeURIComponent(url.pathname.split('/').pop()!);
      if (wf === A) return json(workflow({ id: A }));
      if (wf === D) return json(workflow({ id: D, tags: ['modelVersion:9'] }));
      if (wf === E) return json(workflow({ id: E, moderationStatus: 'Approved' }));
      if (wf === F) return new Response(null, { status: 404 });
      return new Response(null, { status: 599 });
    };
    const result = await getPendingWorkflowGates();
    expect(result.items.map((i) => i.workflowId)).toEqual([A]);
    expect(result.items[0]).toMatchObject({
      ownerId: 1,
      verified: true,
      origin: { kind: 'app-block', appId: 'my-app' },
    });
    expect(result.workflowFilterUnavailable).toBe(false);
    expect(result.ledgerUnavailable).toBe(false);
    // Refunded and ended runs are excluded from the ledger, never fetched.
    const read = fetchMock.mock.calls.map(([u]) => decodeURIComponent(String(u)));
    expect(read.some((u) => u.includes(B) || u.includes(C))).toBe(false);
  });

  it('lists every candidate unfiltered, and says so, when the orchestrator is unreachable', async () => {
    ledger();
    route = () => {
      throw new TypeError('fetch failed');
    };
    const result = await getPendingWorkflowGates();
    expect(result.items.map((i) => i.workflowId)).toEqual([A, D, E, F]);
    expect(result.items.every((i) => !i.verified)).toBe(true);
    expect(result.workflowFilterUnavailable).toBe(true);
  });

  it('treats a 5xx as unreachable, not as "gone"', async () => {
    ledger();
    route = () => new Response(null, { status: 503 });
    const result = await getPendingWorkflowGates();
    expect(result.items).toHaveLength(4);
    expect(result.workflowFilterUnavailable).toBe(true);
  });

  it('says the ledger was unreadable rather than returning an empty queue', async () => {
    chQuery.mockRejectedValue(new Error('clickhouse down'));
    route = () => new Response(null, { status: 599 });
    const result = await getPendingWorkflowGates();
    expect(result).toEqual({
      items: [],
      ledgerUnavailable: true,
      workflowFilterUnavailable: false,
      truncated: false,
    });
  });
});

describe('resolveTrainingWorkflowBlob', () => {
  it('resolves a position to the blob the workflow names', async () => {
    orchestrator([workflow()]);
    expect(await resolveTrainingWorkflowBlob(WF, 0)).toEqual({
      ok: true,
      blobKey: KEY_A,
      ownerId: OWNER,
    });
    expect(await resolveTrainingWorkflowBlob(WF, 1)).toMatchObject({ ok: true, blobKey: KEY_B });
  });

  it('refuses an index past the end of the dataset', async () => {
    orchestrator([workflow()]);
    expect(await resolveTrainingWorkflowBlob(WF, 3)).toEqual({
      ok: false,
      status: 404,
      error: 'No such dataset item.',
    });
    expect(await resolveTrainingWorkflowBlob(WF, -1)).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses an item that is not an orchestrator blob', async () => {
    orchestrator([workflow()]);
    expect(await resolveTrainingWorkflowBlob(WF, 2)).toEqual({
      ok: false,
      status: 404,
      error: 'This dataset item is not a stored blob.',
    });
  });

  it('refuses a malformed workflow id without a read', async () => {
    orchestrator([workflow()]);
    expect(await resolveTrainingWorkflowBlob('../../v2/consumer/blobs', 0)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getTrainingWorkflowDetail', () => {
  it('reads origin, captions and the default 48h gate window for a training step', async () => {
    orchestrator([workflow()]);
    const loaded = await getTrainingWorkflowDetail(WF);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.detail).toMatchObject({
      ownerId: OWNER,
      underReview: true,
      modelVersionId: null,
      origin: { kind: 'app-block', appId: 'my-app' },
      expiresAt: '2026-10-07T12:00:01.000Z',
    });
    expect(loaded.detail.dataset).toMatchObject({
      kind: 'blobs',
      items: [
        { index: 0, caption: 'a cat', media: 'image' },
        { index: 1, caption: null, media: 'video' },
        { index: 2, blobKey: null },
      ],
    });
  });

  it('names the owner from the id even when the workflow metadata claims another user', async () => {
    orchestrator([workflow({ metadata: { userId: 999, ownerId: 999 } })]);
    const loaded = await getTrainingWorkflowDetail(WF);
    expect(loaded.ok && loaded.detail.ownerId).toBe(OWNER);
    expect(usersByIds).toHaveBeenCalledWith([OWNER]);
  });

  it('maps a missing workflow to 404 and an unreachable orchestrator to 502', async () => {
    orchestrator([new Response(null, { status: 404 })]);
    expect(await getTrainingWorkflowDetail(WF)).toMatchObject({ ok: false, status: 404 });
    orchestrator([new Response(null, { status: 500 })]);
    expect(await getTrainingWorkflowDetail(WF)).toMatchObject({ ok: false, status: 502 });
  });
});
