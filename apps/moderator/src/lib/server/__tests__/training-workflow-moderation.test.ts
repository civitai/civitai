import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Workflow-only training runs (Training Studio, App Blocks) have no ModelVersion, so the run is
 * identified, attributed and ruled on purely from the orchestrator's workflow. These cases pin the
 * decisions that are silent when wrong: whose run it is, whether it may be ruled on HERE, whether a
 * ruling actually took, what the queue lists when something cannot be asked, and what the dataset
 * route will serve.
 *
 * Fixture shape follows the manager API, which writes enums PascalCase (`UnderReview`) — checked
 * against a live read on 2026-10-05.
 */

process.env.ORCHESTRATOR_ENDPOINT = 'https://orchestrator.example/';
process.env.ORCHESTRATOR_ACCESS_TOKEN = 'test-token';

const recordModActivity = vi.fn();
const logToAxiom = vi.fn(async (_: Record<string, unknown>) => {});
const usersByIds = vi.fn(async (_: number[]) => new Map<number, { username: string | null }>());
const chQuery = vi.fn();
/** Rows the `ModelFile` lookup behind a model-version claim returns. */
const fileRows = vi.fn(async (): Promise<unknown[]> => []);
let pageGranted = true;

// A query builder whose every call chains, ending in `fileRows`.
const chain: object = new Proxy(
  {},
  {
    get: (_, prop) => (prop === 'then' ? undefined : prop === 'execute' ? fileRows : () => chain),
  }
);

// The SDK's dist does not load under Node's ESM resolver (a directory import), and the workflow-only
// path does not use it — it reads the manager API with plain fetch, which is what these cases stub.
vi.mock('@civitai/client', () => ({ getWorkflow: vi.fn(), createCivitaiClient: vi.fn() }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: chain }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({ $query: chQuery }) }));
vi.mock('$lib/server/mod-activity', () => ({ recordModActivity }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom }));
vi.mock('$lib/server/users.service', () => ({ usersByIds }));
vi.mock('$lib/server/search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('$lib/server/user-actions.service', () => ({ callModEndpoint: vi.fn() }));
vi.mock('$lib/server/access', async () => {
  const { error } = await import('@sveltejs/kit');
  return {
    requireAccess: (_: unknown, path: string) => {
      if (path !== '/audit/training-data' || !pageGranted) error(403, 'no access');
    },
  };
});

const {
  parseWorkflowId,
  moderateTrainingWorkflow,
  getPendingWorkflowGates,
  getTrainingWorkflowDetail,
  resolveTrainingWorkflowBlob,
  clearTrainingWorkflowBlobCache,
  invalidatePendingWorkflowGates,
  getDatasetItemStates,
  MAX_PENDING_CANDIDATES,
} = await import('../training-moderation.service');
const { releaseModerationGate, probeOrchestratorBlob } = await import('../orchestrator');
const { mapBounded, someBounded } = await import('../bounded');
const { hasViewableItem } = await import('$lib/training-workflow');
const blobRoute = await import(
  '../../../routes/api/training-workflow-blob/[workflowId]/[index]/+server'
);
const reviewPage = await import(
  '../../../routes/audit/training-data/workflow/[workflowId]/+page.server'
);

const OWNER = 42;
// Every timestamp field distinct, so a swapped slice cannot read back the same instant.
const WF = `${OWNER}-20261005123456789-abcd`;
const KEY_A = `${'a'.repeat(32)}.png`;
const KEY_B = `${'b'.repeat(32)}.mp4`;

type Fixture = {
  id?: string;
  moderationStatus?: string;
  tags?: string[];
  stepType?: string;
  metadata?: Record<string, unknown>;
  items?: unknown[];
  timeout?: string | null;
  startedAt?: string | null;
};

const workflow = (over: Fixture = {}) => ({
  id: over.id ?? WF,
  status: 'Processing',
  createdAt: '2026-10-05T12:34:56.789Z',
  tags: over.tags ?? ['civitai', 'training', 'app-block:my-app'],
  metadata: over.metadata ?? {},
  steps: [
    {
      $type: over.stepType ?? 'training',
      name: '0',
      status: 'Processing',
      timeout: over.timeout ?? null,
      ...(over.startedAt === null ? {} : { startedAt: over.startedAt ?? '2026-10-05T12:35:00Z' }),
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
/** Serve successive manager reads of WF from `reads`, holding the last one. Dataset items probe as
 *  viewable unless `blob` says otherwise. */
function orchestrator(
  reads: unknown[],
  gate: () => Response = () => new Response(null, { status: 204 }),
  blob: (key: string) => Response | Promise<Response> = () => redirectTo(`${CONTENT}x`)
) {
  let i = 0;
  route = (url, init) => {
    if (url.pathname.endsWith('/moderation-gate') && init?.method === 'POST') return gate();
    if (url.pathname.startsWith('/v2/consumer/blobs/')) return blob(byIdOf(url));
    if (url.pathname === `/v1/manager/workflows/${WF}`) {
      const body = reads[Math.min(i++, reads.length - 1)];
      return body instanceof Response ? body.clone() : json(body);
    }
    return new Response(null, { status: 599 });
  };
}

const callsTo = (suffix: string) =>
  fetchMock.mock.calls.filter(([u]) => String(u).endsWith(suffix));
const gateCalls = () => callsTo('/moderation-gate');
const managerReads = () => callsTo(`/v1/manager/workflows/${WF}`);

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
  fileRows.mockReset();
  fileRows.mockResolvedValue([]);
  pageGranted = true;
  clearTrainingWorkflowBlobCache();
  invalidatePendingWorkflowGates();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const rule = (
  approve: boolean,
  extra: { message?: string; workflowId?: string; delays?: number[] } = {}
) =>
  moderateTrainingWorkflow(
    { workflowId: extra.workflowId ?? WF, approve, message: extra.message, moderatorId: 7 },
    { recheckDelaysMs: extra.delays ?? [0, 0] }
  );

/** A `Training Data` ModelFile row as the claim check reads it. */
const file = (id: number, modelVersionId: number, workflowId: string, completedAt?: string) => ({
  id,
  modelVersionId,
  metadata: { trainingResults: { workflowId, ...(completedAt ? { completedAt } : {}) } },
});

const axiomMessages = () => logToAxiom.mock.calls.map(([d]) => d.message);

describe('parseWorkflowId', () => {
  it('reads the owner and submit instant from both id shapes in use', () => {
    expect(parseWorkflowId(WF)).toEqual({
      ownerId: 42,
      submittedAt: new Date('2026-10-05T12:34:56Z'),
    });
    // The older shape, with no suffix.
    expect(parseWorkflowId('5-20260818171734275')?.ownerId).toBe(5);
  });

  it.each([
    ['empty', ''],
    ['no owner', '-20261005123456789-abcd'],
    ['short timestamp', '42-2026100512-abcd'],
    ['path traversal', '42-20261005123456789/../../admin'],
    ['query smuggling', '42-20261005123456789?x=1'],
    ['owner beyond int4', '9999999999-20261005123456789'],
    ['owner zero', '0-20261005123456789'],
  ])('refuses %s', (_, raw) => {
    expect(parseWorkflowId(raw)).toBeNull();
  });
});

describe('moderateTrainingWorkflow — refusals before the gate', () => {
  it('refuses a malformed id without asking the orchestrator anything', async () => {
    orchestrator([workflow()]);
    const result = await rule(true, { workflowId: '42-not-a-workflow' });
    expect(result).toEqual({ ok: false, error: 'Not a workflow id. Nothing was changed.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a run its version really owns, and points at the version route', async () => {
    orchestrator([workflow({ tags: ['civitai', 'training', 'modelVersion:123'] })]);
    fileRows.mockResolvedValue([file(1, 123, WF)]);
    const result = await rule(true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('/audit/training-data/123');
    expect(gateCalls()).toHaveLength(0);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('does not let a model-version tag the version does not back up block the ruling', async () => {
    // The submitter writes tags; version 123's own training file names a different workflow.
    orchestrator([
      workflow({ tags: ['training', 'modelVersion:123'] }),
      workflow({ moderationStatus: 'Approved' }),
    ]);
    fileRows.mockResolvedValue([file(1, 123, '9-20260101000000000')]);
    expect(await rule(true)).toEqual({ ok: true, moderationStatus: 'approved' });
    expect(gateCalls()).toHaveLength(1);
  });

  it('confirms a claim only against the run the version page would release', async () => {
    // Version 123 has two pending runs; its review acts on the FIRST, so WF is not its gated run.
    orchestrator([
      workflow({ tags: ['training', 'modelVersion:123'] }),
      workflow({ moderationStatus: 'Approved' }),
    ]);
    fileRows.mockResolvedValue([file(1, 123, '9-20260101000000000'), file(2, 123, WF)]);
    expect(await rule(true)).toEqual({ ok: true, moderationStatus: 'approved' });

    // Once the first run has completed, the version's gate review acts on WF — so it is the version's.
    orchestrator([workflow({ tags: ['training', 'modelVersion:123'] })]);
    fileRows.mockResolvedValue([
      file(1, 123, '9-20260101000000000', '2026-01-01T00:00:00Z'),
      file(2, 123, WF),
    ]);
    const result = await rule(true);
    expect(!result.ok && result.error).toContain('/audit/training-data/123');
  });

  it('accepts a body with no id', async () => {
    const { id: _, ...noId } = workflow();
    orchestrator([noId, workflow({ moderationStatus: 'Approved' })]);
    expect(await rule(true)).toEqual({ ok: true, moderationStatus: 'approved' });
  });

  it('treats an unreadable model-version tag as unconfirmed, not as a version run', async () => {
    orchestrator([
      workflow({ tags: ['training', 'modelVersion:abc'] }),
      workflow({ moderationStatus: 'Approved' }),
    ]);
    expect(await rule(true)).toEqual({ ok: true, moderationStatus: 'approved' });
    orchestrator([workflow({ tags: ['training', 'modelVersion:abc'] })]);
    const detail = await getTrainingWorkflowDetail(WF);
    expect(detail.ok && detail.detail).toMatchObject({
      modelVersionId: null,
      versionClaimUnconfirmed: true,
      claimedModelVersionId: -1,
    });
  });

  it('refuses when a model-version claim cannot be checked', async () => {
    orchestrator([workflow({ tags: ['training', 'modelVersion:123'] })]);
    fileRows.mockRejectedValue(new Error('db down'));
    const result = await rule(false);
    expect(!result.ok && result.error).toContain('could not be checked');
    expect(gateCalls()).toHaveLength(0);
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

  it('refuses when the orchestrator answers with a different workflow', async () => {
    orchestrator([workflow({ id: '42-20261005123456999-zzzz' })]);
    const result = await rule(true);
    expect(!result.ok && result.error).toContain('returned a different workflow');
    expect(gateCalls()).toHaveLength(0);
    expect(await getTrainingWorkflowDetail(WF)).toMatchObject({ ok: false, status: 422 });
  });
});

describe('moderateTrainingWorkflow — after the release', () => {
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

  it('keeps re-reading until the status moves', async () => {
    orchestrator([workflow(), workflow(), workflow(), workflow({ moderationStatus: 'Approved' })]);
    expect(await rule(true, { delays: [0, 0, 0] })).toEqual({
      ok: true,
      moderationStatus: 'approved',
    });
    expect(managerReads()).toHaveLength(4);
  });

  it('reports "not applied" when the release is accepted but the run is still under review', async () => {
    orchestrator([workflow(), workflow(), workflow()]);
    const result = await rule(false);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(
      'still reads under review — it was not applied yet'
    );
    expect(gateCalls()).toHaveLength(1);
    // The release was accepted, so the attempt is on record whatever happens next.
    expect(recordModActivity).toHaveBeenCalledWith(
      expect.objectContaining({ activity: 'trainingWorkflow:deny', entityId: OWNER })
    );
    expect(axiomMessages()).toContain('accepted but not applied');
  });

  it('says "unconfirmed", not "retry", when the re-read itself fails', async () => {
    orchestrator([workflow(), new Response(null, { status: 503 })]);
    const result = await rule(true);
    expect(!result.ok && result.error).toContain('could not be re-read to confirm');
    expect(recordModActivity).toHaveBeenCalledTimes(1);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ important: true, message: 'outcome unconfirmed' })
    );
  });

  it('a failed LAST re-read is unconfirmed even if an earlier one read under review', async () => {
    orchestrator([workflow(), workflow(), new Response(null, { status: 503 })]);
    const result = await rule(true);
    expect(!result.ok && result.error).toContain('could not be re-read to confirm');
  });

  it('surfaces a 404 from the gate release and records nothing', async () => {
    orchestrator([workflow()], () => new Response('No pending moderation gate', { status: 404 }));
    const result = await rule(true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('(404)');
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('records a deny as a deny and forwards the trimmed reason', async () => {
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

  it('sends no message on approve, or for a whitespace-only reason, and caps a long one', async () => {
    orchestrator([workflow(), workflow({ moderationStatus: 'Approved' })]);
    await rule(true, { message: 'ignored' });
    orchestrator([workflow(), workflow({ moderationStatus: 'Rejected' })]);
    await rule(false, { message: '   ' });
    orchestrator([workflow(), workflow({ moderationStatus: 'Rejected' })]);
    await rule(false, { message: 'x'.repeat(1500) });
    const bodies = gateCalls().map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies[0]).toEqual({ approved: true });
    expect(bodies[1]).toEqual({ approved: false });
    expect(bodies[2].message).toHaveLength(1000);
  });

  it('does not report success when the run ended in a state the ruling did not ask for', async () => {
    orchestrator([workflow(), workflow({ moderationStatus: 'Rejected' })]);
    const result = await rule(true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('not approved');
    expect(axiomMessages()).toContain('unexpected end state');
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
  const D = id(4, 4); // under review, a model-version run its version owns → dropped
  const E = id(5, 5); // finished → dropped
  const F = id(6, 6); // orchestrator no longer has it → dropped
  const G = id(7, 7); // under review, tag the version does not back up → listed, flagged

  function ledger(ids = [A, B, C, D, E, F, G, 'not-a-workflow-id']) {
    chQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("type = 'training'")) return ids.map((workflowId) => ({ workflowId }));
      if (sql.includes("type = 'refund'")) return [{ workflowId: B }];
      if (sql.includes('orchestration.workflowSteps')) return [{ workflowId: C }];
      throw new Error(`unexpected query ${sql}`);
    });
  }

  const byId = (url: URL) => decodeURIComponent(url.pathname.split('/').pop()!);

  function standardRoute(url: URL) {
    const wf = byId(url);
    if (wf === A) return json(workflow({ id: A }));
    if (wf === D) return json(workflow({ id: D, tags: ['modelVersion:9'] }));
    if (wf === E) return json(workflow({ id: E, moderationStatus: 'Approved' }));
    if (wf === F) return new Response(null, { status: 410 });
    if (wf === G) return json(workflow({ id: G, tags: ['modelVersion:11'] }));
    return new Response(null, { status: 599 });
  }

  it('lists only under-review runs that are not a confirmed version run', async () => {
    ledger();
    route = standardRoute;
    fileRows.mockResolvedValue([file(1, 9, D), file(2, 11, '1-20250101000000000')]);
    usersByIds.mockResolvedValueOnce(
      new Map([
        [1, { username: 'alice' }],
        [7, { username: 'gus' }],
      ])
    );
    const result = await getPendingWorkflowGates();
    expect(result.items.map((i) => i.workflowId)).toEqual([A, G]);
    expect(result.items[0]).toMatchObject({
      ownerId: 1,
      username: 'alice',
      verified: true,
      versionClaimUnconfirmed: false,
      origin: { kind: 'app-block', appId: 'my-app' },
    });
    expect(result.items[1]).toMatchObject({ username: 'gus', versionClaimUnconfirmed: true });
    expect(result.workflowFilterUnavailable).toBe(false);
    expect(result.ledgerUnavailable).toBe(false);
    // Refunded and ended runs are excluded from the ledger, never fetched.
    const read = fetchMock.mock.calls.map(([u]) => decodeURIComponent(String(u)));
    expect(read.some((u) => u.includes(B) || u.includes(C))).toBe(false);
  });

  it('keeps claimed runs listed, unverified, when the version check fails', async () => {
    ledger();
    route = standardRoute;
    fileRows.mockRejectedValue(new Error('db down'));
    const result = await getPendingWorkflowGates();
    expect(result.items.map((i) => [i.workflowId, i.verified])).toEqual([
      [A, true],
      [D, false],
      [G, false],
    ]);
    expect(result.workflowFilterUnavailable).toBe(true);
  });

  it('lists every candidate unfiltered, and says so, when the orchestrator is unreachable', async () => {
    ledger();
    route = () => {
      throw new TypeError('fetch failed');
    };
    const result = await getPendingWorkflowGates();
    expect(result.items.map((i) => i.workflowId)).toEqual([A, D, E, F, G]);
    expect(result.items.every((i) => !i.verified)).toBe(true);
    expect(result.workflowFilterUnavailable).toBe(true);
  });

  it('treats a 5xx as unreachable, not as "gone"', async () => {
    ledger();
    route = () => new Response(null, { status: 503 });
    const result = await getPendingWorkflowGates();
    expect(result.items).toHaveLength(5);
    expect(result.workflowFilterUnavailable).toBe(true);
  });

  it('keeps ledger order when the reads finish in reverse', async () => {
    ledger([A, D, E, F]);
    const pending: (() => void)[] = [];
    route = () =>
      new Promise<Response>((resolve) => {
        pending.push(() => resolve(new Response(null, { status: 503 })));
        if (pending.length === 4) pending.reverse().forEach((release) => release());
      });
    const result = await getPendingWorkflowGates();
    expect(result.items.map((i) => i.workflowId)).toEqual([A, D, E, F]);
  });

  it('reads at most a page of candidates and says the rest were not checked', async () => {
    const many = Array.from(
      { length: MAX_PENDING_CANDIDATES + 1 },
      (_, n) => `${n + 1}-20261005123456789`
    );
    ledger(many);
    route = () => new Response(null, { status: 404 });
    const result = await getPendingWorkflowGates();
    expect(result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_PENDING_CANDIDATES);
  });

  it('bounds the ledger window at 49 hours before now', async () => {
    ledger([]);
    route = () => new Response(null, { status: 599 });
    await getPendingWorkflowGates({ now: Date.parse('2026-10-05T12:00:00Z') });
    const charges = chQuery.mock.calls
      .map(([q]) => String(q))
      .find((q) => q.includes("'training'"));
    expect(charges).toContain("date >= '2026-10-03 11:00:00'");
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
    // Two resolves, one read: the dataset is held briefly.
    expect(managerReads()).toHaveLength(1);
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

  it('keys the held dataset by workflow, and lets it go after a minute', async () => {
    const OTHER = '43-20261005123456789-wxyz';
    const KEY_C = `${'c'.repeat(32)}.jpg`;
    route = (url) =>
      byIdOf(url) === OTHER
        ? json(workflow({ id: OTHER, items: [{ air: KEY_C }] }))
        : json(workflow());
    expect(await resolveTrainingWorkflowBlob(WF, 0)).toMatchObject({ blobKey: KEY_A, ownerId: 42 });
    expect(await resolveTrainingWorkflowBlob(OTHER, 0)).toMatchObject({
      blobKey: KEY_C,
      ownerId: 43,
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    await resolveTrainingWorkflowBlob(WF, 0);
    expect(managerReads()).toHaveLength(2);
  });
});

const byIdOf = (url: URL) => decodeURIComponent(url.pathname.split('/').pop()!);
const CONTENT = '/v2/consumer/blobs/content/';
const BLOCKED = '/v2/consumer/blobs/blocked/';
const redirectTo = (location: string) => new Response(null, { status: 308, headers: { location } });

describe('GET /api/training-workflow-blob/[workflowId]/[index]', () => {
  const call = (index: string, user: { id: number } | null = { id: 7 }) =>
    blobRoute.GET({
      params: { workflowId: WF, index },
      locals: { user },
    } as unknown as Parameters<typeof blobRoute.GET>[0]);

  const status = async (p: unknown) => {
    try {
      const res = (await p) as Response;
      return res.status;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };

  /** The blob read redirects to its content; `blob` answers the content URL. */
  function serve(blob: () => Response) {
    route = (url) => {
      if (url.pathname.startsWith(CONTENT)) return blob();
      if (url.pathname.startsWith('/v2/consumer/blobs/')) return redirectTo(`${CONTENT}tok`);
      return json(workflow());
    };
  }

  it('refuses a blocked item instead of serving the placeholder, and never fetches it', async () => {
    route = (url) => {
      if (url.pathname.startsWith('/v2/consumer/blobs/blocked/'))
        return new Response('placeholder', { headers: { 'content-type': 'image/png' } });
      if (url.pathname.startsWith('/v2/consumer/blobs/')) return redirectTo(`${BLOCKED}tok`);
      return json(workflow());
    };
    expect(await status(call('0'))).toBe(451);
    expect(callsTo('tok')).toHaveLength(0);
    expect(logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'training-workflow-blob' })
    );
  });

  it('answers 502 when the blob read does not redirect to content', async () => {
    route = (url) =>
      url.pathname.startsWith('/v2/consumer/blobs/')
        ? new Response(null, { status: 404 })
        : json(workflow());
    expect(await status(call('0'))).toBe(502);
  });

  it('refuses without a session or without the page grant', async () => {
    serve(() => new Response('x', { headers: { 'content-type': 'image/png' } }));
    expect(await status(call('0', null))).toBe(403);
    pageGranted = false;
    expect(await status(call('0'))).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['-1', '1e3', '12345', '0x1', ''])('refuses index %j', async (index) => {
    serve(() => new Response('x'));
    expect(await status(call(index))).toBe(400);
  });

  it('serves media with its type, fetched by the key the workflow names', async () => {
    serve(() => new Response('png', { headers: { 'content-type': 'image/png; charset=binary' } }));
    const res = (await call('0')) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(callsTo(`/v2/consumer/blobs/${KEY_A}`)).toHaveLength(1);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'training-workflow-blob', moderatorId: 7, index: 0 })
    );
  });

  it.each(['image/svg+xml', 'text/html', 'application/javascript'])(
    'serves %s as an opaque download, never as a document',
    async (type) => {
      serve(() => new Response('<x/>', { headers: { 'content-type': type } }));
      const res = (await call('0')) as Response;
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  );

  it('answers 502 when the upstream refuses or cannot be reached', async () => {
    serve(() => new Response(null, { status: 500 }));
    expect(await status(call('0'))).toBe(502);
    serve(() => {
      throw new TypeError('fetch failed');
    });
    expect(await status(call('0'))).toBe(502);
    route = (url) => {
      if (url.pathname.startsWith('/v2/consumer/blobs/')) throw new TypeError('fetch failed');
      return json(workflow());
    };
    expect(await status(call('0'))).toBe(502);
  });

  it('refuses an item the workflow does not hold', async () => {
    serve(() => new Response('x'));
    expect(await status(call('3'))).toBe(404);
  });
});

describe('review page actions', () => {
  it('rules on the run in the URL, not on an id posted with the form', async () => {
    orchestrator([workflow(), workflow({ moderationStatus: 'Rejected' })]);
    const form = new FormData();
    form.set('workflowId', '1-20260101000000000');
    form.set('reason', 'no');
    const result = await reviewPage.actions.deny({
      params: { workflowId: WF },
      locals: { user: { id: 7 } },
      request: new Request('http://x/', { method: 'POST', body: form }),
    } as unknown as Parameters<typeof reviewPage.actions.deny>[0]);
    expect(result).toEqual({ success: true, moderationStatus: 'rejected' });
    expect(gateCalls()).toHaveLength(1);
    expect(String(gateCalls()[0][0])).toContain(`/workflows/${WF}/moderation-gate`);
    expect(recordModActivity).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }));
  }, 15_000);

  it('returns a refusal as fail(400), not a thrown error', async () => {
    orchestrator([workflow({ moderationStatus: 'Approved' })]);
    const result = await reviewPage.actions.approve({
      params: { workflowId: WF },
      locals: { user: { id: 7 } },
      request: new Request('http://x/', { method: 'POST', body: new FormData() }),
    } as unknown as Parameters<typeof reviewPage.actions.approve>[0]);
    expect(result).toMatchObject({
      status: 400,
      data: { error: expect.stringContaining('not awaiting review') },
    });
  });
});

describe('getTrainingWorkflowDetail', () => {
  it('reads origin, captions, media and the default 48h gate window for a training step', async () => {
    orchestrator([workflow()]);
    const loaded = await getTrainingWorkflowDetail(WF);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.detail).toMatchObject({
      ownerId: OWNER,
      underReview: true,
      modelVersionId: null,
      versionClaimUnconfirmed: false,
      origin: { kind: 'app-block', appId: 'my-app' },
      expiresAt: '2026-10-07T12:35:00.000Z',
    });
    expect(loaded.detail.dataset).toMatchObject({
      kind: 'blobs',
      items: [
        { index: 0, caption: 'a cat', media: { kind: 'image', mimeType: 'image/png' } },
        { index: 1, caption: null, media: { kind: 'video' } },
        { index: 2, blobKey: null, media: null },
      ],
    });
  });

  it('uses 24h for imageResourceTraining, the step timeout when set, and createdAt without a start', async () => {
    orchestrator([workflow({ stepType: 'imageResourceTraining' })]);
    const irt = await getTrainingWorkflowDetail(WF);
    expect(irt.ok && irt.detail.expiresAt).toBe('2026-10-06T12:35:00.000Z');

    orchestrator([workflow({ timeout: '1.02:03:04.5000000' })]);
    const timed = await getTrainingWorkflowDetail(WF);
    // 12:35:00 + 1d 02:03:04
    expect(timed.ok && timed.detail.expiresAt).toBe('2026-10-06T14:38:04.000Z');

    orchestrator([workflow({ startedAt: null })]);
    const unstarted = await getTrainingWorkflowDetail(WF);
    expect(unstarted.ok && unstarted.detail.expiresAt).toBe('2026-10-07T12:34:56.789Z');
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
    orchestrator([new Response(null, { status: 410 })]);
    expect(await getTrainingWorkflowDetail(WF)).toMatchObject({ ok: false, status: 404 });
    orchestrator([new Response(null, { status: 500 })]);
    expect(await getTrainingWorkflowDetail(WF)).toMatchObject({ ok: false, status: 502 });
  });
});

describe('probeOrchestratorBlob', () => {
  const probeWith = (res: () => Response) => {
    route = () => res();
    return probeOrchestratorBlob(KEY_A);
  };

  it('tells a viewable item from a blocked one by where the read redirects', async () => {
    expect(await probeWith(() => redirectTo(`${CONTENT}abc`))).toEqual({
      kind: 'content',
      url: `https://orchestrator.example${CONTENT}abc`,
    });
    expect(await probeWith(() => redirectTo(`${BLOCKED}abc`))).toEqual({ kind: 'blocked' });
    // It asks without following, so the placeholder is never fetched as if it were the item.
    expect(fetchMock.mock.calls.every(([, init]) => init.redirect === 'manual')).toBe(true);
  });

  it('accepts no target off the orchestrator origin, and no unknown path', async () => {
    expect(await probeWith(() => redirectTo(`https://elsewhere.example${CONTENT}abc`))).toEqual({
      kind: 'unavailable',
      status: 308,
    });
    expect(await probeWith(() => redirectTo('/somewhere/else'))).toEqual({
      kind: 'unavailable',
      status: 308,
    });
    expect(await probeWith(() => new Response(null, { status: 404 }))).toEqual({
      kind: 'unavailable',
      status: 404,
    });
  });
});

describe('getDatasetItemStates', () => {
  const dataset = {
    kind: 'blobs' as const,
    items: [
      { index: 0, blobKey: KEY_A, caption: null, media: null },
      { index: 1, blobKey: KEY_B, caption: null, media: null },
      { index: 2, blobKey: null, caption: null, media: null },
      { index: 3, blobKey: `${'d'.repeat(32)}.png`, caption: null, media: null },
    ],
  };

  it('counts a busy or failing orchestrator as no answer (unchecked), not as a missing item', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      route = () => new Response(null, { status });
      expect(await getDatasetItemStates(dataset)).toEqual({
        0: 'unchecked',
        1: 'unchecked',
        3: 'unchecked',
      });
    }
  });

  it('labels each stored item viewable, blocked or unavailable, skipping non-blobs', async () => {
    route = (url) => {
      const key = byIdOf(url);
      if (key === KEY_A) return redirectTo(`${CONTENT}a`);
      if (key === KEY_B) return redirectTo(`${BLOCKED}b`);
      return new Response(null, { status: 404 });
    };
    expect(await getDatasetItemStates(dataset)).toEqual({
      0: 'viewable',
      1: 'blocked',
      3: 'unavailable',
    });
  });

  it('marks items unchecked, never viewable, when the orchestrator hangs or fails', async () => {
    route = (url) =>
      byIdOf(url) === KEY_A
        ? new Promise<Response>(() => {})
        : (() => {
            throw new TypeError('fetch failed');
          })();
    expect(await getDatasetItemStates(dataset, { budgetMs: 30 })).toEqual({
      0: 'unchecked',
      1: 'unchecked',
      3: 'unchecked',
    });
  });

  it('has nothing to probe for an archive dataset', async () => {
    expect(await getDatasetItemStates({ kind: 'archive', count: 3 })).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('approving a dataset that cannot be previewed', () => {
  const archive = () => {
    const w = workflow();
    (w.steps[0].input as Record<string, unknown>).trainingData = { type: 'zip', count: 4 };
    return w;
  };

  it('is refused without the moderator confirming they reviewed it another way', async () => {
    orchestrator([archive()]);
    const result = await rule(true);
    expect(!result.ok && result.error).toContain('could be confirmed viewable');
    expect(gateCalls()).toHaveLength(0);
  });

  it('goes through with the confirmation, and deny never needs it', async () => {
    orchestrator([archive(), workflow({ moderationStatus: 'Approved' })]);
    expect(
      await moderateTrainingWorkflow(
        { workflowId: WF, approve: true, moderatorId: 7, reviewedElsewhere: true },
        { recheckDelaysMs: [0] }
      )
    ).toEqual({ ok: true, moderationStatus: 'approved' });
    orchestrator([archive(), workflow({ moderationStatus: 'Rejected' })]);
    expect(await rule(false)).toEqual({ ok: true, moderationStatus: 'rejected' });
  });

  it('a blob dataset with no stored item counts as unpreviewable too', async () => {
    orchestrator([workflow({ items: [{ air: 'https://elsewhere.example/x.png' }] })]);
    const result = await rule(true);
    expect(!result.ok && result.error).toContain('could be confirmed viewable');
    expect(gateCalls()).toHaveLength(0);
  });

  it("is refused when every stored item is blocked or unserved, judged by the server's own probe", async () => {
    orchestrator([workflow()], undefined, (key) =>
      key === KEY_A ? redirectTo(`${BLOCKED}a`) : new Response(null, { status: 404 })
    );
    const result = await rule(true);
    expect(!result.ok && result.error).toContain('could be confirmed viewable');
    expect(gateCalls()).toHaveLength(0);
    // The server probed the items itself.
    expect(callsTo(`/v2/consumer/blobs/${KEY_A}`)).toHaveLength(1);
  });

  it('is refused when the probe cannot answer in time (fail safe)', async () => {
    orchestrator([workflow()], undefined, () => new Promise<Response>(() => {}));
    const result = await moderateTrainingWorkflow(
      { workflowId: WF, approve: true, moderatorId: 7 },
      { recheckDelaysMs: [0], probeBudgetMs: 30 }
    );
    expect(!result.ok && result.error).toContain('could be confirmed viewable');
    expect(gateCalls()).toHaveLength(0);
  });

  it('stops probing at the first viewable item', async () => {
    const many = Array.from({ length: 40 }, (_, n) => ({
      air: `${n.toString(16).padStart(32, '0')}.png`,
    }));
    orchestrator([workflow({ items: many }), workflow({ moderationStatus: 'Approved' })]);
    expect(await rule(true)).toEqual({ ok: true, moderationStatus: 'approved' });
    // One wave of 8 concurrent probes answers; nothing more is started.
    expect(callsTo('.png').length).toBeLessThanOrEqual(8);
  });

  it('tells the page the tick is wanted, so it can ask even if its own probe saw an item', async () => {
    orchestrator([workflow()], undefined, () => new Response(null, { status: 503 }));
    const result = await reviewPage.actions.approve({
      params: { workflowId: WF },
      locals: { user: { id: 7 } },
      request: new Request('http://x/', { method: 'POST', body: new FormData() }),
    } as unknown as Parameters<typeof reviewPage.actions.approve>[0]);
    expect(result).toMatchObject({ status: 400, data: { needsAck: true } });
    // Other refusals do not ask for it.
    orchestrator([workflow({ moderationStatus: 'Approved' })]);
    const other = await reviewPage.actions.approve({
      params: { workflowId: WF },
      locals: { user: { id: 7 } },
      request: new Request('http://x/', { method: 'POST', body: new FormData() }),
    } as unknown as Parameters<typeof reviewPage.actions.approve>[0]);
    expect((other as { data: Record<string, unknown> }).data.needsAck).toBeUndefined();
  });

  it('one viewable item is enough, even beside blocked ones', async () => {
    orchestrator([workflow(), workflow({ moderationStatus: 'Approved' })], undefined, (key) =>
      key === KEY_A ? redirectTo(`${BLOCKED}a`) : redirectTo(`${CONTENT}b`)
    );
    expect(await rule(true)).toEqual({ ok: true, moderationStatus: 'approved' });
  });

  it('a previewable dataset needs no confirmation', async () => {
    orchestrator([workflow(), workflow({ moderationStatus: 'Approved' })]);
    expect(await rule(true)).toEqual({ ok: true, moderationStatus: 'approved' });
  });

  it('the page action passes the tick through', async () => {
    orchestrator([archive(), workflow({ moderationStatus: 'Approved' })]);
    const form = new FormData();
    form.set('reviewedElsewhere', 'yes');
    const result = await reviewPage.actions.approve({
      params: { workflowId: WF },
      locals: { user: { id: 7 } },
      request: new Request('http://x/', { method: 'POST', body: form }),
    } as unknown as Parameters<typeof reviewPage.actions.approve>[0]);
    expect(result).toEqual({ success: true, moderationStatus: 'approved' });
  }, 15_000);
});

describe('the pending queue is bounded and shared', () => {
  const ids = [1, 2, 3].map((n) => `${n}-20261005123456789`);
  const ledgerOf = (list: string[]) =>
    chQuery.mockImplementation(async (sql: string) =>
      sql.includes("type = 'training'") ? list.map((workflowId) => ({ workflowId })) : []
    );

  it('lists what did not answer within the budget as unchecked, without waiting for it', async () => {
    ledgerOf(ids);
    route = (url) =>
      byIdOf(url) === ids[0] ? json(workflow({ id: ids[0] })) : new Promise<Response>(() => {});
    const started = Date.now();
    const result = await getPendingWorkflowGates({ readBudgetMs: 50 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.items.map((i) => [i.workflowId, i.verified])).toEqual([
      [ids[0], true],
      [ids[1], false],
      [ids[2], false],
    ]);
    expect(result.workflowFilterUnavailable).toBe(true);
  });

  it('serves concurrent and repeat loads from one build, until a ruling clears it', async () => {
    ledgerOf(ids);
    route = (url) => json(workflow({ id: byIdOf(url) }));
    const [a, b] = await Promise.all([getPendingWorkflowGates(), getPendingWorkflowGates()]);
    await getPendingWorkflowGates();
    expect(a).toBe(b);
    expect(chQuery).toHaveBeenCalledTimes(3); // one build: three ledger queries

    // A ruling made here clears it, so the ruled run does not linger in the queue.
    orchestrator([workflow(), workflow({ moderationStatus: 'Approved' })]);
    await rule(true);
    route = (url) => json(workflow({ id: byIdOf(url) }));
    await getPendingWorkflowGates();
    expect(chQuery).toHaveBeenCalledTimes(6);
  });

  it('does not hold on to a ledger failure', async () => {
    chQuery.mockRejectedValueOnce(new Error('down'));
    route = () => new Response(null, { status: 599 });
    expect((await getPendingWorkflowGates()).ledgerUnavailable).toBe(true);
    ledgerOf([]);
    expect((await getPendingWorkflowGates()).ledgerUnavailable).toBe(false);
  });

  it('expires after its window', async () => {
    ledgerOf([]);
    route = () => new Response(null, { status: 599 });
    await getPendingWorkflowGates();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    await getPendingWorkflowGates();
    expect(chQuery).toHaveBeenCalledTimes(6);
  });
});

describe('hasViewableItem', () => {
  it('needs at least one item that probed viewable — not merely a stored or answered one', () => {
    expect(hasViewableItem({})).toBe(false);
    expect(hasViewableItem({ 0: 'blocked', 1: 'unavailable', 2: 'unchecked' })).toBe(false);
    expect(hasViewableItem({ 0: 'blocked', 1: 'viewable' })).toBe(true);
  });
});

describe('someBounded', () => {
  it('starts nothing after the deadline', async () => {
    const started: number[] = [];
    const found = await someBounded(
      [0, 1, 2],
      (n) => {
        started.push(n);
        return n === 0 ? new Promise<boolean>(() => {}) : Promise.resolve(true);
      },
      { concurrency: 1, budgetMs: 20 }
    );
    expect(found).toBe(false);
    expect(started).toEqual([0]);
  });

  it('answers at the first true without waiting for calls still in flight', async () => {
    const started = Date.now();
    const found = await someBounded(
      [0, 1],
      (n) => (n === 0 ? new Promise<boolean>(() => {}) : Promise.resolve(true)),
      { concurrency: 2, budgetMs: 5_000 }
    );
    expect(found).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stops starting calls at the first true', async () => {
    const started: number[] = [];
    const found = await someBounded(
      [0, 1, 2, 3],
      async (n) => {
        started.push(n);
        return n === 1;
      },
      { concurrency: 1, budgetMs: 1_000 }
    );
    expect(found).toBe(true);
    expect(started).toEqual([0, 1]);
  });

  it('is false on the deadline, on rejection, and on nothing to ask — never true by default', async () => {
    expect(
      await someBounded([0], () => new Promise<boolean>(() => {}), {
        concurrency: 1,
        budgetMs: 20,
      })
    ).toBe(false);
    expect(
      await someBounded(
        [0, 1],
        (n) => (n === 0 ? Promise.reject(new Error('x')) : Promise.resolve(false)),
        {
          concurrency: 1,
          budgetMs: 1_000,
        }
      )
    ).toBe(false);
    expect(await someBounded([], async () => true, { concurrency: 2, budgetMs: 10 })).toBe(false);
  });
});

describe('mapBounded', () => {
  it('starts nothing after the deadline', async () => {
    const started: number[] = [];
    await mapBounded(
      [0, 1, 2, 3],
      (n) => {
        started.push(n);
        return n === 0 ? new Promise<number>(() => {}) : Promise.resolve(n);
      },
      { concurrency: 1, budgetMs: 20 }
    );
    expect(started).toEqual([0]);
  });

  it('holds a rejection to its own slot and keeps the deadline for the rest', async () => {
    const started: number[] = [];
    const result = await mapBounded(
      [0, 1, 2, 3],
      (n) => {
        started.push(n);
        if (n === 0) return Promise.reject(new Error('boom'));
        if (n === 2) return new Promise<number>(() => {});
        return Promise.resolve(n * 10);
      },
      { concurrency: 1, budgetMs: 30 }
    );
    expect(result).toEqual([undefined, 10, undefined, undefined]);
    expect(started).toEqual([0, 1, 2]);
  });

  it('keeps order, respects concurrency, and leaves unfinished slots undefined', async () => {
    let running = 0;
    let peak = 0;
    const result = await mapBounded(
      [5, 1, 3, 1000],
      async (ms) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, ms));
        running--;
        return ms * 2;
      },
      { concurrency: 2, budgetMs: 100 }
    );
    expect(result).toEqual([10, 2, 6, undefined]);
    expect(peak).toBe(2);
  });
});
