import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Check page's test-set actions with the harness and the runs service faked: who may use them,
 * what a set run starts and when it asks first. Runs themselves are text-scan-runs.pglite.test.ts.
 */

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: vi.fn() }));

const access = vi.hoisted(() => ({ canAccess: vi.fn() }));
vi.mock('$lib/server/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/access')>()),
  canAccess: access.canAccess,
}));

const harness = vi.hoisted(() => ({ scanTexts: vi.fn(), composeEntities: vi.fn() }));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/text-scan-lab/harness-client')>()),
  ...harness,
}));

const runs = vi.hoisted(() => ({
  prepareRun: vi.fn(),
  prepareRerun: vi.fn(),
  casesPerSecond: vi.fn(),
  getRunOutcome: vi.fn(),
}));
vi.mock('$lib/server/text-scan-lab/runs.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/text-scan-lab/runs.service')>()),
  ...runs,
}));

const sets = vi.hoisted(() => ({ getCase: vi.fn(), getCases: vi.fn(), listSets: vi.fn() }));
vi.mock('$lib/server/text-scan-lab/test-sets.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/text-scan-lab/test-sets.service')>()),
  ...sets,
}));

const { actions } = await import('../+page.server');
const { RunError } = await import('$lib/server/text-scan-lab/runs.service');

const ME = 11;

type ActionName = 'checkCase' | 'runSet' | 'rerunSetErrors' | 'setRunSummary';
const post = (name: ActionName, fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  const event = {
    request: { formData: async () => data },
    locals: { user: { id: ME }, grants: {} },
  } as unknown as Parameters<(typeof actions)[ActionName]>[0];
  return actions[name](event) as Promise<Record<string, any>>;
};

const testCase = (over: Record<string, unknown> = {}) => ({
  id: 5,
  setId: 3,
  entityType: 'Comment',
  entityId: 77,
  authorId: 9,
  fields: [{ heading: 'Comment', text: 'buy now' }],
  expected: { scam: true },
  sourceDeletedAt: null,
  ...over,
});

const scanned = (key: string, scam: boolean) => ({
  key,
  ok: true,
  workflowId: `wf-${key}`,
  promptIds: {},
  output: { scam: { detected: scam, reason: '' } },
  elapsedMs: 5,
});

/** A planned run of `count` cases whose execute starts run `runId`, which never finishes here. */
const planned = (count: number, runId: number, stamp = `${count}:`) => ({
  count,
  skipped: 0,
  stamp,
  execute: vi.fn(async () => ({
    run: { id: runId, status: 'running' },
    finished: new Promise(() => {}),
  })),
});

const outcome = (runId: number, rows: unknown[] = [], errors: unknown[] = []) => ({
  run: { id: runId, status: 'done' },
  rows,
  errors,
});

beforeEach(() => {
  vi.clearAllMocks();
  access.canAccess.mockReturnValue(true);
  runs.casesPerSecond.mockResolvedValue(null);
  runs.getRunOutcome.mockImplementation(async (_set: number, runId: number) => outcome(runId));
  sets.getCase.mockImplementation(async (_set: number, id: number) => testCase({ id }));
});

describe('test-set actions need the test-sets page', () => {
  it.each<[ActionName, Record<string, string>]>([
    ['checkCase', { setId: '3', caseId: '5' }],
    ['runSet', { setId: '3' }],
    ['rerunSetErrors', { setId: '3', runId: '1', currentRunId: '1' }],
    ['setRunSummary', { setId: '3', currentRunId: '1' }],
  ])('%s refuses without it, before anything runs', async (name, fields) => {
    access.canAccess.mockReturnValue(false);
    expect(await post(name, fields)).toMatchObject({ status: 403 });
    expect(access.canAccess).toHaveBeenCalledWith({ id: ME }, '/text-scan/test-sets');
    expect(sets.getCase).not.toHaveBeenCalled();
    expect(runs.prepareRun).not.toHaveBeenCalled();
    expect(runs.prepareRerun).not.toHaveBeenCalled();
    expect(runs.getRunOutcome).not.toHaveBeenCalled();
  });
});

describe('checkCase', () => {
  it("scans the case's snapshot and carries its expectation, with and without the changes", async () => {
    harness.scanTexts.mockImplementation(async (_t: string, texts: { key: string }[]) =>
      texts.map((t) => scanned(t.key, true))
    );
    const res = await post('checkCase', {
      setId: '3',
      caseId: '5',
      overrides: JSON.stringify({ 'label:scam': 'MY SCAM DEF' }),
    });

    expect(sets.getCase).toHaveBeenCalledWith(3, 5);
    const texts = [{ key: 'case-5', fields: [{ heading: 'Comment', text: 'buy now' }] }];
    expect(harness.scanTexts).toHaveBeenCalledWith('Comment', texts);
    expect(harness.scanTexts).toHaveBeenCalledWith('Comment', texts, {
      'label:scam': 'MY SCAM DEF',
    });
    expect(res).toMatchObject({
      checked: true,
      entityType: 'Comment',
      labels: ['scam'],
      items: [
        {
          title: 'Test case 5 · Model comment (old) 77',
          entityId: 77,
          fromCase: { setId: 3, caseId: 5, expected: { scam: true } },
          current: { ok: true },
          changed: { ok: true },
        },
      ],
    });
  });

  it('refuses a wiped case and one from another set without scanning', async () => {
    sets.getCase.mockResolvedValueOnce(testCase({ fields: null, sourceDeletedAt: new Date() }));
    expect(await post('checkCase', { setId: '3', caseId: '5' })).toMatchObject({ status: 400 });
    sets.getCase.mockResolvedValueOnce(null);
    expect(await post('checkCase', { setId: '3', caseId: '5' })).toMatchObject({ status: 404 });
    expect(harness.scanTexts).not.toHaveBeenCalled();
  });

  it('names a blank change before loading anything', async () => {
    const res = await post('checkCase', {
      setId: '3',
      caseId: '5',
      overrides: JSON.stringify({ 'label:scam': ' ' }),
    });
    expect(res).toMatchObject({ status: 400, data: { error: expect.stringMatching(/^Scam/) } });
    expect(sets.getCase).not.toHaveBeenCalled();
  });
});

describe('runSet', () => {
  it('starts a small set with the current prompts only, as me, answering before it scans', async () => {
    const current = planned(2, 40);
    runs.prepareRun.mockResolvedValueOnce(current);

    const res = await post('runSet', { setId: '3' });

    expect(runs.prepareRun).toHaveBeenCalledTimes(1);
    expect(runs.prepareRun).toHaveBeenCalledWith({ setId: 3, version: 'active' }, ME);
    expect(current.execute).toHaveBeenCalledWith(ME);
    expect(res).toEqual({
      started: true,
      setId: 3,
      currentRunId: 40,
      changedRunId: null,
      changedError: null,
    });
    expect(runs.getRunOutcome).not.toHaveBeenCalled();
  });
});

describe('setRunSummary', () => {
  it('scores the finished runs and names the cases it lists, in one lookup', async () => {
    runs.getRunOutcome.mockResolvedValueOnce(
      outcome(
        40,
        [
          {
            caseId: 5,
            expected: { scam: true },
            status: 'ok',
            output: { scam: { detected: true } },
            wiped: false,
          },
          {
            caseId: 6,
            expected: { scam: false },
            status: 'error',
            output: { error: 'boom' },
            wiped: false,
          },
        ],
        [{ caseId: 6, error: 'boom' }]
      )
    );

    sets.getCases.mockImplementation(async (_set: number, ids: number[]) =>
      ids.map((id) => testCase({ id }))
    );

    const res = await post('setRunSummary', { setId: '3', currentRunId: '40', changedRunId: '' });

    expect(sets.getCases).toHaveBeenCalledWith(3, [6]);
    expect(res).toMatchObject({
      setRun: true,
      setId: 3,
      current: { runId: 40, errors: [{ caseId: 6, error: 'boom' }] },
      changed: null,
      summary: { labels: [{ label: 'scam', current: { correct: 1, scored: 1 }, changed: null }] },
    });
    expect(Object.keys(res.cases)).toEqual(['6']);
  });
});

describe('runSet — confirming', () => {
  it('asks before running more than 10 cases twice, estimating from both runs', async () => {
    const current = planned(40, 1, '40:');
    const changed = planned(40, 2, '40:2026-10-06T00:00:00.000Z');
    runs.prepareRun.mockResolvedValueOnce(current).mockResolvedValueOnce(changed);
    runs.casesPerSecond.mockResolvedValue(4);

    const res = await post('runSet', { setId: '3', draftId: '12' });

    expect(runs.prepareRun).toHaveBeenLastCalledWith({ setId: 3, version: 12 }, ME);
    expect(res).toEqual({
      needsConfirm: true,
      count: 40,
      skipped: 0,
      stamp: '40:|40:2026-10-06T00:00:00.000Z',
      seconds: 20,
      changed: false,
    });
    expect(current.execute).not.toHaveBeenCalled();
    expect(changed.execute).not.toHaveBeenCalled();
  });

  it('runs both once confirmed with that stamp', async () => {
    const current = planned(40, 1, '40:');
    const changed = planned(40, 2, '40:x');
    runs.prepareRun.mockResolvedValueOnce(current).mockResolvedValueOnce(changed);

    const res = await post('runSet', { setId: '3', draftId: '12', confirmed: '40:|40:x' });

    expect(current.execute).toHaveBeenCalledWith(ME);
    expect(changed.execute).toHaveBeenCalledWith(ME);
    expect(res).toMatchObject({ currentRunId: 1, changedRunId: 2, changedError: null });
  });

  it('keeps the current results when the run with changes is refused', async () => {
    const changed = planned(2, 2);
    changed.execute.mockRejectedValueOnce(new RunError('Draft overrides no prompt.', 400));
    runs.prepareRun.mockResolvedValueOnce(planned(2, 1)).mockResolvedValueOnce(changed);

    const res = await post('runSet', { setId: '3', draftId: '12' });

    expect(res).toMatchObject({
      currentRunId: 1,
      changedRunId: null,
      changedError: 'Draft overrides no prompt.',
    });
  });

  it("passes a refusal through, such as another moderator's working copy", async () => {
    runs.prepareRun
      .mockResolvedValueOnce(planned(2, 1))
      .mockRejectedValueOnce(new RunError('Draft 12 not found.', 404));
    expect(await post('runSet', { setId: '3', draftId: '12' })).toMatchObject({
      status: 404,
      data: { error: 'Draft 12 not found.' },
    });
  });
});

describe('rerunSetErrors', () => {
  it("refuses a run that is not one of the pair's", async () => {
    expect(
      await post('rerunSetErrors', { setId: '3', runId: '9', currentRunId: '1', changedRunId: '2' })
    ).toMatchObject({ status: 400 });
    expect(runs.prepareRerun).not.toHaveBeenCalled();
  });

  it('starts the re-run as me and answers with the pair to follow', async () => {
    const rerun = planned(3, 2);
    runs.prepareRerun.mockResolvedValueOnce(rerun);

    const res = await post('rerunSetErrors', {
      setId: '3',
      runId: '2',
      currentRunId: '1',
      changedRunId: '2',
    });

    expect(runs.prepareRerun).toHaveBeenCalledWith(3, 2, ME);
    expect(rerun.execute).toHaveBeenCalledWith(ME);
    expect(res).toEqual({
      started: true,
      setId: 3,
      currentRunId: 1,
      changedRunId: 2,
      changedError: null,
    });
  });
});
