import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB as ModeratorDB } from '../moderator-db/types';
import type { Workspace } from '$lib/text-scan-tests/types';
import { MOD, useTestSetsDb, seedCase, seedRun, seedSet } from './text-scan-tests-pglite.harness';

vi.mock('../user-actions.service', () => ({
  callModEndpoint: vi.fn(),
  callModEndpointAs: vi.fn(),
  requestCookie: vi.fn(() => null),
}));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => ({}) }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: vi.fn(async () => undefined) }));
vi.mock('$lib/server/mod-activity', () => ({ recordModActivity: vi.fn(async () => undefined) }));

const { LabHarnessError } = await import('../text-scan-lab/harness-client');
const { runsDeps } = await import('../text-scan-tests/deps');
const { cancelRun, quoteRun, rerunErrors, startRun } = await import('../text-scan-tests/runs');
const { upsertCase } = await import('../text-scan-tests/store');

let pg: PGlite;
let db: Kysely<ModeratorDB>;
let setId: number;

const ACTIVE = {
  base: { id: 1, key: 'base', content: 'synthetic base' },
  'label:scam': { id: 2, key: 'label:scam', content: 'synthetic scam' },
};
const DRAFT = { prompts: { 'label:scam': 'synthetic draft' } };

function makeDeps() {
  const prompts = {
    active: { ...ACTIVE },
    config: { model: 'model-a', maxInputChars: 1000, thinking: false },
  };
  const deps = {
    db,
    getPrompts: vi.fn(async () => prompts),
    quoteTexts: vi.fn(async () => ({ count: 1, quoted: 1, maxCostTotal: 1 })),
    launch: vi.fn(),
    audit: vi.fn(),
  };
  return { deps, prompts };
}

const sets = useTestSetsDb();

beforeEach(async () => {
  ({ pg, db } = sets);
  setId = await seedSet(db);
});

const seedCases = async (n: number) => {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(await seedCase(db, setId));
  return ids;
};

async function completeBaseline(caseIds: number[], over: Parameters<typeof seedRun>[2] = {}) {
  const runId = await seedRun(db, setId, { status: 'done', finishedAt: new Date(), ...over });
  await db
    .insertInto('text_scan_test_result')
    .values(
      caseIds.map((id) => ({
        run_id: String(runId),
        case_id: String(id),
        status: 'ok',
        output: '{}',
      }))
    )
    .execute();
  return runId;
}

const cancelDeps = () => ({ db, audit: vi.fn() });
const runs = () => db.selectFrom('text_scan_test_run').selectAll().orderBy('id').execute();

describe('quoteRun', () => {
  it('quotes both sides when there is no baseline', async () => {
    await seedCases(3);
    const { deps } = makeDeps();
    expect(await quoteRun(deps, setId, 'prompts', DRAFT)).toMatchObject({
      cases: 3,
      calls: 6,
      buzz: 6,
      perCallBuzz: 1,
      measured: true,
      baseline: 'new',
      draft: true,
    });
    expect(deps.quoteTexts).toHaveBeenCalledWith(
      'CommentV2',
      expect.arrayContaining([expect.objectContaining({ fields: expect.any(Array) })]),
      { 'label:scam': 'synthetic draft' }
    );
  });

  it('reuses a fresh baseline, quoting only the draft side', async () => {
    await completeBaseline(await seedCases(3));
    const { deps } = makeDeps();
    expect(await quoteRun(deps, setId, 'prompts', DRAFT)).toMatchObject({
      calls: 3,
      baseline: 'reuse',
    });
  });

  it('a baseline goes stale when a prompt is saved', async () => {
    await completeBaseline(await seedCases(3));
    const { deps, prompts } = makeDeps();
    prompts.active['label:scam'] = { ...ACTIVE['label:scam'], id: 3 };
    expect(await quoteRun(deps, setId, 'prompts', DRAFT)).toMatchObject({
      calls: 6,
      baseline: 'new',
    });
  });

  it('tops up a fresh baseline with the cases added since', async () => {
    const ids = await seedCases(2);
    await completeBaseline(ids);
    await seedCases(1);
    const { deps } = makeDeps();
    expect(await quoteRun(deps, setId, 'prompts', DRAFT)).toMatchObject({
      calls: 4,
      baseline: 'top-up',
    });
  });

  it('tops up a baseline whose case text changed when it was re-added', async () => {
    const add = (text: string) =>
      upsertCase(
        db,
        {
          setId,
          entityType: 'CommentV2',
          entityId: 71,
          authorId: null,
          sourceRef: null,
          fields: [{ heading: 'Comment', text }],
          expected: { scam: false },
          note: null,
          origin: 'try',
        },
        MOD
      );
    const changed = await add('synthetic text one');
    await completeBaseline([changed.case.id, ...(await seedCases(1))]);
    await add('synthetic text two');
    const { deps } = makeDeps();
    expect(await quoteRun(deps, setId, 'prompts', null)).toMatchObject({
      baseline: 'top-up',
      calls: 1,
    });
  });

  it('refuses a run with nothing to do', async () => {
    await completeBaseline(await seedCases(2));
    const { deps } = makeDeps();
    await expect(quoteRun(deps, setId, 'prompts', null)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses more than 500 cases before calling the harness', async () => {
    await pg.exec(
      `INSERT INTO text_scan_test_case (set_id, entity_type, fields, text_hash, origin, added_by, updated_by)
       SELECT ${setId}, 'CommentV2', '[{"heading":"Comment","text":"synthetic"}]'::jsonb, 'h' || g, 'try', 1, 1
       FROM generate_series(1, 501) g`
    );
    const { deps } = makeDeps();
    await expect(quoteRun(deps, setId, 'prompts', DRAFT)).rejects.toMatchObject({ status: 400 });
    expect(deps.getPrompts).not.toHaveBeenCalled();
    expect(deps.quoteTexts).not.toHaveBeenCalled();
  });

  it('treats a draft that edits no prompt the set uses as no draft', async () => {
    await seedCases(3);
    const { deps } = makeDeps();
    expect(
      await quoteRun(deps, setId, 'prompts', { prompts: { 'label:nsfw': 'synthetic' } })
    ).toMatchObject({ draft: false, baseline: 'new', calls: 3 });
  });

  it('falls back to 1 Buzz a call when the quote fails', async () => {
    await seedCases(2);
    const { deps } = makeDeps();
    deps.quoteTexts.mockRejectedValue(new LabHarnessError('Text-scan quote returned 502.'));
    expect(await quoteRun(deps, setId, 'prompts', DRAFT)).toMatchObject({
      perCallBuzz: 1,
      measured: false,
      buzz: 4,
    });
  });

  it('refuses a set stored under the retired Model rules workspace', async () => {
    await seedCases(1);
    const { deps } = makeDeps();
    await expect(quoteRun(deps, setId, 'modelRules' as Workspace, DRAFT)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('startRun', () => {
  it('starts a baseline and a draft as one start, and launches both', async () => {
    await seedCases(3);
    const { deps } = makeDeps();
    const quote = await quoteRun(deps, setId, 'prompts', DRAFT);
    const started = await startRun(
      deps,
      { setId, workspace: 'prompts', draft: DRAFT, stamp: quote.stamp },
      MOD
    );

    const [baseline, draft] = await runs();
    expect(baseline).toMatchObject({
      kind: 'baseline',
      status: 'queued',
      prompt_ids: { base: 1, scam: 2 },
      case_total: 3,
    });
    expect(draft).toMatchObject({
      kind: 'draft',
      baseline_run_id: baseline.id,
      start_id: baseline.start_id,
      prompt_ids: { base: 1, scam: 0 },
      prompt_overrides: { 'label:scam': 'synthetic draft' },
    });
    expect(draft.expires_at!.getTime() - Date.now()).toBeGreaterThan(89 * 86_400_000);
    expect(deps.launch.mock.calls.map(([id]) => id)).toEqual(started.runIds);
    expect(started.runId).toBe(Number(draft.id));
  });

  it('reopens a fresh baseline to top it up', async () => {
    const ids = await seedCases(2);
    const baselineId = await completeBaseline(ids);
    const added = await seedCase(db, setId);
    const { deps } = makeDeps();
    const quote = await quoteRun(deps, setId, 'prompts', DRAFT);
    await startRun(deps, { setId, workspace: 'prompts', draft: DRAFT, stamp: quote.stamp }, MOD);
    const [baseline, draft] = await runs();
    // PGlite returns int8 as a number and node-postgres as a string; compare as numbers.
    expect(Number(baseline.id)).toBe(baselineId);
    expect(Number(baseline.max_case_id)).toBe(added);
    expect(baseline.status).toBe('queued');
    expect(draft.kind).toBe('draft');
    expect(Number(draft.baseline_run_id)).toBe(baselineId);
  });

  it('writes nothing when pricing the start fails', async () => {
    await seedCases(2);
    const { deps } = makeDeps();
    const quote = await quoteRun(deps, setId, 'prompts', DRAFT);
    deps.quoteTexts.mockRejectedValueOnce(new Error('synthetic pricing failure'));
    await expect(
      startRun(deps, { setId, workspace: 'prompts', draft: DRAFT, stamp: quote.stamp }, MOD)
    ).rejects.toThrow('synthetic pricing failure');
    expect(await runs()).toHaveLength(0);
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('a cancelled queued top-up leaves the baseline done, at its old finish', async () => {
    const finishedAt = new Date('2026-09-01T00:00:00Z');
    const baselineId = await completeBaseline(await seedCases(2), { finishedAt });
    await seedCase(db, setId);
    const { deps } = makeDeps();
    const quote = await quoteRun(deps, setId, 'prompts', null);
    await startRun(deps, { setId, workspace: 'prompts', draft: null, stamp: quote.stamp }, MOD);
    expect((await runs())[0]).toMatchObject({ status: 'queued', started_at: null });
    await cancelRun(cancelDeps(), setId, baselineId, MOD, false);
    expect((await runs())[0]).toMatchObject({ status: 'done', finished_at: finishedAt });
  });

  it('refuses a start whose estimate is stale, writing nothing', async () => {
    await seedCases(2);
    const { deps } = makeDeps();
    const quote = await quoteRun(deps, setId, 'prompts', DRAFT);
    await seedCase(db, setId);
    await expect(
      startRun(deps, { setId, workspace: 'prompts', draft: DRAFT, stamp: quote.stamp }, MOD)
    ).rejects.toMatchObject({ status: 409 });
    expect(await runs()).toHaveLength(0);
  });

  it('allows one active start per moderator', async () => {
    await seedCases(1);
    await seedRun(db, setId, { status: 'running', runBy: MOD });
    const { deps } = makeDeps();
    const quote = await quoteRun(deps, setId, 'prompts', DRAFT);
    await expect(
      startRun(deps, { setId, workspace: 'prompts', draft: DRAFT, stamp: quote.stamp }, MOD)
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already have a run/) });
  });

  it('allows three active starts in total, counting a pair as one', async () => {
    await seedCases(1);
    const pair = '00000000-0000-4000-8000-000000000001';
    await seedRun(db, setId, { status: 'running', runBy: 1, startId: pair });
    await seedRun(db, setId, { status: 'queued', runBy: 1, startId: pair, kind: 'draft' });
    await seedRun(db, setId, { status: 'running', runBy: 2 });
    const { deps } = makeDeps();
    const quote = await quoteRun(deps, setId, 'prompts', DRAFT);
    await expect(
      startRun(deps, { setId, workspace: 'prompts', draft: DRAFT, stamp: quote.stamp }, MOD)
    ).resolves.toBeDefined();

    const { deps: again } = makeDeps();
    const next = await quoteRun(again, setId, 'prompts', DRAFT);
    await expect(
      startRun(again, { setId, workspace: 'prompts', draft: DRAFT, stamp: next.stamp }, 4)
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already in progress/) });
  });
});

describe('audit', () => {
  it('records a start with its run ids, call count and estimate, never text', async () => {
    await seedCases(2);
    const { deps } = makeDeps();
    const quote = await quoteRun(deps, setId, 'prompts', DRAFT);
    const started = await startRun(
      deps,
      { setId, workspace: 'prompts', draft: DRAFT, stamp: quote.stamp },
      MOD
    );
    expect(deps.audit).toHaveBeenCalledOnce();
    expect(deps.audit).toHaveBeenCalledWith({
      action: 'start',
      userId: MOD,
      setId,
      runIds: started.runIds,
      calls: quote.calls,
      buzz: quote.buzz,
    });
  });

  it('derives the estimate from a fresh server quote, not the caller', async () => {
    await seedCases(2);
    const { deps } = makeDeps();
    deps.quoteTexts.mockResolvedValue({ count: 1, quoted: 1, maxCostTotal: 2.5 });
    const quote = await quoteRun(deps, setId, 'prompts', DRAFT);
    await startRun(deps, { setId, workspace: 'prompts', draft: DRAFT, stamp: quote.stamp }, MOD);
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ calls: 4, buzz: 10 }));
  });

  it('still records a start when the audit sink throws', async () => {
    await seedCases(1);
    const { deps } = makeDeps();
    deps.audit.mockRejectedValue(new Error('sink down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const quote = await quoteRun(deps, setId, 'prompts', DRAFT);
    await expect(
      startRun(deps, { setId, workspace: 'prompts', draft: DRAFT, stamp: quote.stamp }, MOD)
    ).resolves.toBeDefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('records nothing for a refused start', async () => {
    await seedCases(2);
    const { deps } = makeDeps();
    await expect(
      startRun(deps, { setId, workspace: 'prompts', draft: DRAFT, stamp: 'stale' }, MOD)
    ).rejects.toMatchObject({ status: 409 });
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it('records a cancel with the runs it touched', async () => {
    const start = '00000000-0000-4000-8000-000000000003';
    const a = await seedRun(db, setId, { status: 'running', startId: start });
    const b = await seedRun(db, setId, { status: 'queued', startId: start, kind: 'draft' });
    const audit = vi.fn();
    await cancelRun({ db, audit }, setId, b, MOD, false);
    expect(audit).toHaveBeenCalledOnce();
    const event = audit.mock.calls[0][0];
    expect(event).toMatchObject({ action: 'cancel', userId: MOD, setId });
    expect([...event.runIds].sort()).toEqual([a, b].sort());
  });

  it('records a re-run as a start of the same run', async () => {
    const [a] = await seedCases(1);
    const runId = await seedRun(db, setId, { status: 'done' });
    await db
      .insertInto('text_scan_test_result')
      .values({
        run_id: String(runId),
        case_id: String(a),
        status: 'error',
        error: 'synthetic failure',
      })
      .execute();
    const { deps } = makeDeps();
    await rerunErrors(deps, setId, runId, MOD);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'start', setId, runIds: [runId], calls: 1 })
    );
  });
});

describe('cancelRun', () => {
  it('cancels every run of the start: queued ones at once, running ones between chunks', async () => {
    const start = '00000000-0000-4000-8000-000000000002';
    const a = await seedRun(db, setId, { status: 'running', startId: start });
    const b = await seedRun(db, setId, { status: 'queued', startId: start, kind: 'draft' });
    expect(await cancelRun(cancelDeps(), setId, b, MOD, false)).toBe(2);
    const rows = await runs();
    expect(rows.find((r) => Number(r.id) === a)?.status).toBe('cancelling');
    expect(rows.find((r) => Number(r.id) === b)).toMatchObject({
      status: 'cancelled',
      finished_at: expect.any(Date),
    });
  });

  it("refuses another moderator's run without the edit grant, and allows it with", async () => {
    const runId = await seedRun(db, setId, { status: 'running', runBy: 7 });
    await expect(cancelRun(cancelDeps(), setId, runId, MOD, false)).rejects.toMatchObject({
      status: 403,
    });
    await expect(cancelRun(cancelDeps(), setId, runId, MOD, true)).resolves.toBe(1);
  });

  it('refuses a run that is not in progress', async () => {
    const runId = await seedRun(db, setId, { status: 'done' });
    await expect(cancelRun(cancelDeps(), setId, runId, MOD, false)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('rerunErrors', () => {
  async function runWithErrors(over: Parameters<typeof seedRun>[2] = {}) {
    const [a, b, c] = await seedCases(3);
    const runId = await seedRun(db, setId, { status: 'done', ...over });
    await db
      .insertInto('text_scan_test_result')
      .values([
        { run_id: String(runId), case_id: String(a), status: 'ok', output: '{}' },
        { run_id: String(runId), case_id: String(b), status: 'error', error: 'synthetic failure' },
        { run_id: String(runId), case_id: String(c), status: 'error', error: 'synthetic failure' },
      ])
      .execute();
    return runId;
  }

  it('drops the error rows and requeues the run with its recorded prompts', async () => {
    const runId = await runWithErrors();
    const { deps } = makeDeps();
    await rerunErrors(deps, setId, runId, MOD);
    const rows = await db
      .selectFrom('text_scan_test_result')
      .select('status')
      .where('run_id', '=', String(runId))
      .execute();
    expect(rows.map((r) => r.status)).toEqual(['ok']);
    expect((await runs())[0]).toMatchObject({ status: 'queued', error_count: 0 });
    expect(deps.launch).toHaveBeenCalledWith(runId);
  });

  it('refuses when a prompt the run used was saved since', async () => {
    const runId = await runWithErrors();
    const { deps, prompts } = makeDeps();
    prompts.active['label:scam'] = { ...ACTIVE['label:scam'], id: 9 };
    await expect(rerunErrors(deps, setId, runId, MOD)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/label:scam prompt changed/),
    });
  });

  it('refuses a stopped run that still has unscanned cases, deleting nothing', async () => {
    const runId = await runWithErrors({ status: 'cancelled' });
    await seedCase(db, setId);
    const { deps } = makeDeps();
    await expect(rerunErrors(deps, setId, runId, MOD)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/not scanned/),
    });
    expect(await db.selectFrom('text_scan_test_result').selectAll().execute()).toHaveLength(3);
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('re-runs a stopped run whose only gaps are its errors, as a fresh start', async () => {
    const runId = await runWithErrors({ status: 'failed' });
    await db
      .updateTable('text_scan_test_run')
      .set({ started_at: new Date('2026-09-01T00:00:00Z') })
      .execute();
    const { deps } = makeDeps();
    await rerunErrors(deps, setId, runId, MOD);
    expect((await runs())[0]).toMatchObject({ status: 'queued', started_at: null });
  });

  it('refuses an expired draft', async () => {
    const runId = await runWithErrors({ kind: 'draft', expiresAt: new Date('2026-01-01') });
    const { deps } = makeDeps();
    await expect(rerunErrors(deps, setId, runId, MOD)).rejects.toMatchObject({ status: 409 });
    expect(await db.selectFrom('text_scan_test_result').selectAll().execute()).toHaveLength(3);
  });

  it('refuses a run with no errors, and one still running', async () => {
    const clean = await seedRun(db, setId, { status: 'done' });
    const running = await seedRun(db, setId, { status: 'running' });
    const { deps } = makeDeps();
    await expect(rerunErrors(deps, setId, clean, MOD)).rejects.toMatchObject({ status: 400 });
    await expect(rerunErrors(deps, setId, running, MOD)).rejects.toMatchObject({ status: 409 });
  });
});

describe('runsDeps', () => {
  it('refuses to build without a session credential', () => {
    expect(() => runsDeps(null)).toThrowError(expect.objectContaining({ status: 401 }));
    expect(() => runsDeps('')).toThrowError(expect.objectContaining({ status: 401 }));
    expect(runsDeps('civ-token=synthetic').audit).toBeTypeOf('function');
  });
});
