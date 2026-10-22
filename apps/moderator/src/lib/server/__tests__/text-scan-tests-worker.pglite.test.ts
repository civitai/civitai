import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import type { Workspace } from '$lib/text-scan-tests/types';
import type { LabOverrides } from '../text-scan-lab/harness-client';
import { HARNESS_LIMITS } from '$lib/text-scan-lab/limits';
import type { LabScanResult, LabText } from '$lib/text-scan-lab/types';
import {
  MOD,
  PROMPT_IDS,
  useMainDb,
  useTestSetsDb,
  resultsOf,
  seedCase,
  seedRun,
  seedSet,
} from './text-scan-tests-pglite.harness';

// The real module imports `$app/server`, which only exists inside SvelteKit.
vi.mock('../user-actions.service', () => ({
  callModEndpoint: vi.fn(),
  callModEndpointAs: vi.fn(),
}));

const { callModEndpoint } = await import('../user-actions.service');
const { LabHarnessError, scanTexts } = await import('../text-scan-lab/harness-client');
const { PROMPT_MOVED, claimRun, releaseOwnLeases, resumableRunIds, runWorker } = await import(
  '../text-scan-tests/worker'
);
const { baselineHistory } = await import('../text-scan-tests/reports');

let db: Kysely<ModeratorDB>;
let main: Kysely<MainDB>;
let setId: number;

const sets = useTestSetsDb();
const mains = useMainDb();

beforeEach(async () => {
  vi.clearAllMocks();
  ({ db } = sets);
  ({ main } = mains);
  setId = await seedSet(db);
});

const okResult = (key: string, promptIds = PROMPT_IDS): LabScanResult => ({
  key,
  ok: true,
  workflowId: `wf-${key}`,
  promptIds,
  output: { scam: { detected: false, reason: 'synthetic' } },
  elapsedMs: 1,
});

type Call = { entityType: string; keys: string[]; chars: number; overrides?: LabOverrides };

function fakeScan(
  impl?: (texts: LabText[], call: number) => Promise<LabScanResult[]> | LabScanResult[]
) {
  const calls: Call[] = [];
  const fn = vi.fn(async (entityType: string, texts: LabText[], overrides?: LabOverrides) => {
    calls.push({
      entityType,
      keys: texts.map((t) => t.key),
      chars: texts.reduce((n, t) => n + t.fields.reduce((m, f) => m + f.text.length, 0), 0),
      overrides,
    });
    const results = impl ? await impl(texts, calls.length) : texts.map((t) => okResult(t.key));
    return { results, system: null };
  });
  return { fn, calls };
}

const deps = (scan: ReturnType<typeof fakeScan>['fn'], workerId = 'host-a:1:aaaa') => ({
  db,
  main,
  scanTexts: scan,
  workerId,
  log: vi.fn(),
});

const seedCases = async (n: number, over: Parameters<typeof seedCase>[2] = {}) => {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(await seedCase(db, setId, over));
  return ids;
};

const runRow = (id: number) =>
  db
    .selectFrom('text_scan_test_run')
    .selectAll()
    .where('id', '=', String(id))
    .executeTakeFirstOrThrow();

const stale = () => new Date(Date.now() - 6 * 60_000);

describe('runWorker', () => {
  it('scans by entity type in chunks of at most 8 and finishes with totals', async () => {
    await seedCases(10);
    await seedCases(3, { entityType: 'Model', expected: {} });
    const runId = await seedRun(db, setId);
    const scan = fakeScan();
    await runWorker(deps(scan.fn), runId);

    expect(scan.calls.map((c) => [c.entityType, c.keys.length])).toEqual([
      ['CommentV2', 8],
      ['CommentV2', 2],
      ['Model', 3],
    ]);
    expect(await runRow(runId)).toMatchObject({
      status: 'done',
      case_done: 13,
      error_count: 0,
      lease_owner: null,
      totals: [{ label: 'scam', scored: 10, passed: 10 }],
    });
  });

  it('never sends more than 8 texts or 1M characters in one call', async () => {
    for (let i = 0; i < 6; i++) await seedCase(db, setId, { text: `${i}`.repeat(190_000) });
    const runId = await seedRun(db, setId);
    const scan = fakeScan();
    await runWorker(deps(scan.fn), runId);
    expect(scan.calls.map((c) => c.keys.length)).toEqual([5, 1]);
    expect(Math.max(...scan.calls.map((c) => c.chars))).toBeLessThanOrEqual(1_000_000);
  });

  it('turns an oversize text into its own error without sinking the chunk', async () => {
    const [big] = await seedCases(1, { text: 'x'.repeat(HARNESS_LIMITS.charsPerText + 1) });
    await seedCases(2);
    vi.mocked(callModEndpoint).mockImplementation(async (_path, body) => ({
      ok: true,
      body: {
        results: (body.texts as LabText[]).map((t) => ({
          ...okResult(t.key),
          parse: { ok: true, output: { scam: { detected: false } } },
        })),
      },
    }));
    const runId = await seedRun(db, setId);
    await runWorker({ ...deps(fakeScan().fn), scanTexts }, runId);

    expect(vi.mocked(callModEndpoint)).toHaveBeenCalledTimes(1);
    expect((vi.mocked(callModEndpoint).mock.calls[0][1].texts as LabText[]).length).toBe(2);
    const rows = await resultsOf(db, runId);
    expect(rows.find((r) => Number(r.case_id) === big)).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/too large/),
    });
    expect(rows.filter((r) => r.status === 'ok')).toHaveLength(2);
  });

  it('resumes a stale run, scanning only cases without a result', async () => {
    const ids = await seedCases(10);
    const runId = await seedRun(db, setId, {
      status: 'running',
      leaseOwner: 'host-dead:1:dead',
      heartbeatAt: stale(),
    });
    await db
      .insertInto('text_scan_test_result')
      .values(
        ids
          .slice(0, 8)
          .map((id) => ({ run_id: String(runId), case_id: String(id), status: 'ok', output: '{}' }))
      )
      .execute();
    const scan = fakeScan();
    await runWorker(deps(scan.fn), runId);
    expect(scan.calls.flatMap((c) => c.keys)).toEqual(ids.slice(8).map(String));
    expect(await runRow(runId)).toMatchObject({ status: 'done', case_done: 10 });
  });

  it('passes a draft run its recorded overrides', async () => {
    await seedCases(1);
    const runId = await seedRun(db, setId, {
      kind: 'draft',
      promptIds: { base: 1, scam: 0 },
      promptOverrides: { 'label:scam': 'synthetic draft' },
    });
    const scan = fakeScan((texts) => texts.map((t) => okResult(t.key, { base: 1, scam: 0 })));
    await runWorker(deps(scan.fn), runId);
    expect(scan.calls[0].overrides).toEqual({ prompts: { 'label:scam': 'synthetic draft' } });
    expect(await runRow(runId)).toMatchObject({ status: 'done' });
  });
});

describe('leases', () => {
  it('only one of two racing workers claims a run', async () => {
    const runId = await seedRun(db, setId);
    const scan = fakeScan();
    const claims = await Promise.all([
      claimRun(deps(scan.fn, 'host-a:1:a'), runId),
      claimRun(deps(scan.fn, 'host-b:1:b'), runId),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('does not reclaim a running run whose heartbeat is fresh', async () => {
    const runId = await seedRun(db, setId, {
      status: 'running',
      leaseOwner: 'host-a:1:a',
      heartbeatAt: new Date(),
    });
    expect(await claimRun(deps(fakeScan().fn, 'host-b:1:b'), runId)).toBeNull();
  });

  it('a worker that lost its lease writes nothing and the new owner rescans only the unsaved chunk', async () => {
    await seedCases(12);
    const runId = await seedRun(db, setId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const scanA = fakeScan(async (texts, call) => {
      if (call === 2) await gate;
      return texts.map((t) => okResult(t.key));
    });
    const workerA = runWorker(deps(scanA.fn, 'host-a:1:a'), runId);
    await vi.waitFor(() => expect(scanA.calls).toHaveLength(2));

    await db
      .updateTable('text_scan_test_run')
      .set({ heartbeat_at: stale() })
      .where('id', '=', String(runId))
      .execute();
    const scanB = fakeScan();
    await runWorker(deps(scanB.fn, 'host-b:1:b'), runId);
    release();
    await workerA;

    expect(scanB.calls.flatMap((c) => c.keys)).toEqual(scanA.calls[1].keys);
    expect(scanA.calls).toHaveLength(2);
    expect(await resultsOf(db, runId)).toHaveLength(12);
    expect(await runRow(runId)).toMatchObject({ status: 'done', lease_owner: null });
  });

  it('releases only this host leases at boot, making them resumable at once', async () => {
    const mine = await seedRun(db, setId, {
      status: 'running',
      leaseOwner: 'host-a:7:x',
      heartbeatAt: new Date(),
    });
    await seedRun(db, setId, {
      status: 'running',
      leaseOwner: 'host-b:7:y',
      heartbeatAt: new Date(),
    });
    const queued = await seedRun(db, setId);
    await seedRun(db, setId, { status: 'done' });

    expect(await releaseOwnLeases(db, 'host-a')).toBe(1);
    expect(await resumableRunIds(db)).toEqual([mine, queued]);
  });
});

describe('cancellation and failures', () => {
  it('stops between chunks when cancelled, keeping the chunk in flight', async () => {
    await seedCases(12);
    const runId = await seedRun(db, setId);
    const scan = fakeScan(async (texts) => {
      await db
        .updateTable('text_scan_test_run')
        .set({ status: 'cancelling' })
        .where('id', '=', String(runId))
        .execute();
      return texts.map((t) => okResult(t.key));
    });
    await runWorker(deps(scan.fn), runId);
    expect(scan.calls).toHaveLength(1);
    expect(await resultsOf(db, runId)).toHaveLength(8);
    expect(await runRow(runId)).toMatchObject({
      status: 'cancelled',
      totals: [{ label: 'scam', scored: 8 }],
    });
  });

  it('ends a stale cancelling run as cancelled without scanning', async () => {
    await seedCases(2);
    const runId = await seedRun(db, setId, {
      status: 'cancelling',
      leaseOwner: 'host-dead:1:d',
      heartbeatAt: stale(),
    });
    const scan = fakeScan();
    await runWorker(deps(scan.fn), runId);
    expect(scan.calls).toHaveLength(0);
    expect(await runRow(runId)).toMatchObject({ status: 'cancelled' });
  });

  it('records a failed chunk as per-case errors and carries on', async () => {
    await seedCases(12);
    const runId = await seedRun(db, setId);
    const scan = fakeScan((texts, call) => {
      if (call === 2) throw new LabHarnessError('Text-scan scan returned 502.');
      return texts.map((t) => okResult(t.key));
    });
    await runWorker(deps(scan.fn), runId);
    expect(await runRow(runId)).toMatchObject({ status: 'done', case_done: 12, error_count: 4 });
  });

  it('fails the run when its first request is refused outright', async () => {
    await seedCases(3);
    const runId = await seedRun(db, setId);
    const scan = fakeScan(() => {
      throw new LabHarnessError('Text-scan scan failed: no session to forward.');
    });
    await runWorker(deps(scan.fn), runId, { launch: true });
    expect(await runRow(runId)).toMatchObject({
      status: 'failed',
      failure: 'Text-scan scan failed: no session to forward.',
    });
    expect(await resultsOf(db, runId)).toHaveLength(0);
  });

  it('fails the run when a prompt is saved mid-run, writing none of that chunk', async () => {
    await seedCases(3);
    const runId = await seedRun(db, setId);
    const scan = fakeScan((texts) => texts.map((t) => okResult(t.key, { base: 1, scam: 3 })));
    await runWorker(deps(scan.fn), runId);
    expect(await runRow(runId)).toMatchObject({ status: 'failed', failure: PROMPT_MOVED });
    expect(await resultsOf(db, runId)).toHaveLength(0);
  });

  it('a case removed mid-run does not fail the chunk', async () => {
    const ids = await seedCases(8);
    const runId = await seedRun(db, setId);
    const scan = fakeScan(async (texts) => {
      await db.deleteFrom('text_scan_test_case').where('id', '=', String(ids[3])).execute();
      return texts.map((t) => okResult(t.key));
    });
    await runWorker(deps(scan.fn), runId);
    expect(await runRow(runId)).toMatchObject({ status: 'done', case_done: 7 });
  });

  it('logs only an error code when something unexpected stops a run', async () => {
    await seedCases(1);
    const runId = await seedRun(db, setId);
    const log = vi.fn();
    const scan = fakeScan(() => {
      throw Object.assign(new Error('row (synthetic text) violates'), { code: '23514' });
    });
    await runWorker({ ...deps(scan.fn), log }, runId);
    expect(log).toHaveBeenCalledWith('text-scan test run failed', { runId, error: '23514' });
    expect(await runRow(runId)).toMatchObject({ status: 'failed' });
  });
});

describe('a topped-up baseline that does not finish', () => {
  const finishedAt = new Date('2026-09-01T00:00:00Z');
  // A done baseline over the first 8 cases, reopened for 4 cases added since.
  async function reopenedBaseline() {
    const ids = await seedCases(12);
    const runId = await seedRun(db, setId, { status: 'queued', finishedAt, totals: [] });
    await db
      .insertInto('text_scan_test_result')
      .values(
        ids.slice(0, 8).map((id) => ({
          run_id: String(runId),
          case_id: String(id),
          status: 'ok',
          output: JSON.stringify({ scam: { detected: false } }),
        }))
      )
      .execute();
    return runId;
  }
  const expectRestored = async (runId: number, scored = 8) => {
    expect(await runRow(runId)).toMatchObject({
      status: 'done',
      failure: null,
      finished_at: finishedAt,
      lease_owner: null,
      totals: [expect.objectContaining({ label: 'scam', scored, passed: scored })],
    });
    expect((await baselineHistory(db, setId)).map((p) => p.runId)).toEqual([runId]);
  };

  it('is done again, at its old finish, when cancelled mid-scan', async () => {
    const runId = await reopenedBaseline();
    const scan = fakeScan(async (texts) => {
      await db
        .updateTable('text_scan_test_run')
        .set({ status: 'cancelling' })
        .where('id', '=', String(runId))
        .execute();
      return texts.map((t) => okResult(t.key));
    });
    await runWorker(deps(scan.fn), runId);
    expect(await resultsOf(db, runId)).toHaveLength(12);
    await expectRestored(runId, 12);
  });

  it('is done again, at its old finish, when a prompt moves mid-scan', async () => {
    const runId = await reopenedBaseline();
    const scan = fakeScan((texts) => texts.map((t) => okResult(t.key, { base: 1, scam: 3 })));
    await runWorker(deps(scan.fn), runId);
    await expectRestored(runId);
  });

  it('fails its launch, rather than pausing, when the first request is refused', async () => {
    const runId = await reopenedBaseline();
    const scan = fakeScan(() => {
      throw new LabHarnessError('Text-scan scan returned 401.', false, true);
    });
    await runWorker(deps(scan.fn), runId, { launch: true });
    await expectRestored(runId);
  });
});

describe('auth refusals and live state', () => {
  const expectPaused = async (runId: number) => {
    const run = await runRow(runId);
    expect(run).toMatchObject({ status: 'running', lease_owner: null, finished_at: null });
    expect(await resumableRunIds(db)).toContain(runId);
  };

  it('pauses on an auth refusal once scanning began, writing no rows for that chunk', async () => {
    await seedCases(12);
    const runId = await seedRun(db, setId);
    const scan = fakeScan((texts, call) => {
      if (call === 2) throw new LabHarnessError('Text-scan scan returned 401.', false, true);
      return texts.map((t) => okResult(t.key));
    });
    await runWorker(deps(scan.fn), runId);

    const rows = await resultsOf(db, runId);
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.status === 'ok')).toBe(true);
    await expectPaused(runId);
  });

  it('pauses when a later request inside one scan is refused for auth', async () => {
    await seedCases(12);
    const runId = await seedRun(db, setId);
    const scan = fakeScan(async (texts) => texts.map((t) => okResult(t.key)));
    let call = 0;
    const refusingLater = vi.fn(async (...args: Parameters<typeof scan.fn>) => {
      const run = await scan.fn(...args);
      call++;
      return call === 2 ? { ...run, authRefused: true as const } : run;
    });
    await runWorker(deps(refusingLater), runId);

    expect(await resultsOf(db, runId)).toHaveLength(8);
    await expectPaused(runId);
  });

  it('a paused run resumes and scans only the missing cases', async () => {
    const ids = await seedCases(12);
    const runId = await seedRun(db, setId);
    await runWorker(
      deps(
        fakeScan((texts, call) => {
          if (call === 2) throw new LabHarnessError('Text-scan scan returned 403.', false, true);
          return texts.map((t) => okResult(t.key));
        }).fn
      ),
      runId
    );
    const scan = fakeScan();
    await runWorker(deps(scan.fn, 'host-b:1:b'), runId);
    expect(scan.calls.flatMap((c) => c.keys)).toEqual(ids.slice(8).map(String));
    expect(await runRow(runId)).toMatchObject({ status: 'done', case_done: 12, error_count: 0 });
  });

  const refusedSession = () =>
    fakeScan(() => {
      throw new LabHarnessError('Text-scan scan returned 401.', false, true);
    });

  it('pauses a queued run resumed by another viewer whose session is refused', async () => {
    await seedCases(3);
    const runId = await seedRun(db, setId);
    await runWorker(deps(refusedSession().fn), runId);
    expect(await resultsOf(db, runId)).toHaveLength(0);
    expect(await runRow(runId)).toMatchObject({
      status: 'running',
      lease_owner: null,
      failure: null,
    });
  });

  it('pauses a previously started run with no rows, even when relaunched', async () => {
    await seedCases(3);
    const runId = await seedRun(db, setId, {
      status: 'running',
      leaseOwner: 'host-dead:1:d',
      heartbeatAt: stale(),
    });
    await db
      .updateTable('text_scan_test_run')
      .set({ started_at: new Date(Date.now() - 60 * 60_000) })
      .where('id', '=', String(runId))
      .execute();
    await runWorker(deps(refusedSession().fn), runId, { launch: true });
    expect(await resultsOf(db, runId)).toHaveLength(0);
    expect(await runRow(runId)).toMatchObject({
      status: 'running',
      lease_owner: null,
      failure: null,
    });
  });

  it('resumes only runs in the workspaces the viewer can open', async () => {
    const rulesSet = await seedSet(db, { workspace: 'modelRules' });
    const promptsRun = await seedRun(db, setId);
    const rulesRun = await seedRun(db, rulesSet);
    expect(await resumableRunIds(db, ['modelRules' as Workspace])).toEqual([rulesRun]);
    expect(await resumableRunIds(db, ['prompts'])).toEqual([promptsRun]);
    expect(await resumableRunIds(db, [])).toEqual([]);
  });
});

describe('deleted sources', () => {
  it('wipes a case whose source was deleted and never sends it', async () => {
    await main
      .insertInto('User')
      .values([{ id: 10 }, { id: 11, deletedAt: new Date() }] as never)
      .execute();
    await main
      .insertInto('Model')
      .values([
        { id: 1, userId: 10 },
        { id: 2, userId: 10, deletedAt: new Date() },
        { id: 3, userId: 11 },
      ] as never)
      .execute();
    const [live, removed, authorGone] = [
      await seedCase(db, setId, { entityType: 'Model', entityId: 1, authorId: 10, expected: {} }),
      await seedCase(db, setId, { entityType: 'Model', entityId: 2, authorId: 10, expected: {} }),
      await seedCase(db, setId, { entityType: 'Model', entityId: 3, authorId: 11, expected: {} }),
    ];
    const prewiped = await seedCase(db, setId, { fields: null });
    const runId = await seedRun(db, setId);
    const scan = fakeScan();
    await runWorker(deps(scan.fn), runId);

    expect(scan.calls.flatMap((c) => c.keys)).toEqual([String(live)]);
    const byCase = new Map((await resultsOf(db, runId)).map((r) => [Number(r.case_id), r.status]));
    expect(Object.fromEntries(byCase)).toEqual({
      [live]: 'ok',
      [removed]: 'skipped',
      [authorGone]: 'skipped',
      [prewiped]: 'skipped',
    });
    const wiped = await db
      .selectFrom('text_scan_test_case')
      .select(['id', 'fields', 'source_deleted_at'])
      .where('id', 'in', [String(removed), String(authorGone)])
      .execute();
    expect(wiped.every((c) => c.fields === null && c.source_deleted_at !== null)).toBe(true);
  });
});

it('the fixture moderator id is the harness default', () => {
  expect(MOD).toBe(990001);
});
