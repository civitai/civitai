import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Access from '$lib/server/access';
import type * as Runs from '$lib/server/text-scan-tests/runs';
import type * as Store from '$lib/server/text-scan-tests/store';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => ({}) }));
vi.mock('$lib/server/axiom', () => ({
  logToAxiom: vi.fn(async () => undefined),
  logAxiomError: vi.fn(),
}));

const DEPS = vi.hoisted(() => ({ db: { synthetic: 'db' }, audit: () => undefined }));
const session = vi.hoisted(() => ({
  requestCookie: vi.fn((): string | null => 'session=synthetic'),
}));
vi.mock('$lib/server/user-actions.service', () => session);
const deps = vi.hoisted(() => ({
  runsDeps: vi.fn(),
  kickResume: vi.fn(),
}));
vi.mock('$lib/server/text-scan-tests/deps', () => deps);

const access = vi.hoisted(() => ({ canAccess: vi.fn(() => true) }));
vi.mock('$lib/server/access', async (importOriginal) => ({
  ...(await importOriginal<typeof Access>()),
  ...access,
}));
const runs = vi.hoisted(() => ({
  quoteRun: vi.fn(),
  startRun: vi.fn(),
  cancelRun: vi.fn(),
  rerunErrors: vi.fn(),
}));
vi.mock('$lib/server/text-scan-tests/runs', async (importOriginal) => ({
  ...(await importOriginal<typeof Runs>()),
  ...runs,
}));
const store = vi.hoisted(() => ({
  requireSet: vi.fn(),
  getRun: vi.fn(),
  getCase: vi.fn(),
  updateExpectation: vi.fn(),
  removeCase: vi.fn(),
  archiveSet: vi.fn(),
}));
vi.mock('$lib/server/text-scan-tests/store', async (importOriginal) => ({
  ...(await importOriginal<typeof Store>()),
  ...store,
}));
const totals = vi.hoisted(() => ({ refreshSetTotals: vi.fn(async () => 1) }));
vi.mock('$lib/server/text-scan-tests/totals', () => totals);
const reports = vi.hoisted(() => ({
  setOverview: vi.fn(),
  toRunView: vi.fn((row: { id: string }) => ({ id: Number(row.id) })),
}));
vi.mock('$lib/server/text-scan-tests/reports', () => reports);
const activity = vi.hoisted(() => ({ recordModActivity: vi.fn(async () => undefined) }));
vi.mock('$lib/server/mod-activity', () => activity);

const {
  archiveSetAction,
  cancelAction,
  editCaseAction,
  quoteAction,
  removeCaseAction,
  rerunAction,
  startAction,
} = await import('../text-scan-tests/form-actions');
const { TestSetError } = await import('../text-scan-tests/store');
const { GET } = await import('../../../routes/text-scan/test-sets/[setId]/overview/+server');
const { GET: progress } = await import(
  '../../../routes/text-scan/test-sets/[setId]/runs/[runId]/progress/+server'
);

const USER = { id: 1, roles: [] };
const event = (fields: Record<string, string>, grants: Record<string, boolean> = {}) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: USER, grants },
  } as unknown as Parameters<typeof quoteAction>[0];
};

const DRAFT = {
  setId: '3',
  prompts: JSON.stringify({ 'label:scam': 'synthetic draft' }),
};

beforeEach(() => {
  vi.clearAllMocks();
  access.canAccess.mockReturnValue(true);
  session.requestCookie.mockReturnValue('session=synthetic');
  deps.runsDeps.mockImplementation((credential: string | null) => {
    if (!credential) throw new TestSetError('Your session could not be read.', 401);
    return DEPS;
  });
  runs.quoteRun.mockResolvedValue({ calls: 2, stamp: 's' });
  runs.startRun.mockResolvedValue({ startId: 'x', runIds: [5, 6], runId: 6 });
  runs.cancelRun.mockResolvedValue(2);
  store.requireSet.mockResolvedValue({ id: 3, workspace: 'prompts' });
  reports.setOverview.mockResolvedValue({ set: { id: 3 } });
});

describe('quoteAction', () => {
  it('quotes with the page grant alone, under the request session, passing the draft', async () => {
    expect(await quoteAction(event(DRAFT), 'prompts')).toEqual({ quote: { calls: 2, stamp: 's' } });
    expect(deps.runsDeps).toHaveBeenCalledWith('session=synthetic');
    expect(runs.quoteRun).toHaveBeenCalledWith(DEPS, 3, 'prompts', {
      prompts: { 'label:scam': 'synthetic draft' },
    });
  });

  it('passes no draft when nothing is edited', async () => {
    await quoteAction(event({ setId: '3', prompts: '{}' }), 'prompts');
    expect(runs.quoteRun).toHaveBeenCalledWith(DEPS, 3, 'prompts', null);
  });

  it('refuses a blank draft prompt before quoting', async () => {
    const blank = { ...DRAFT, prompts: JSON.stringify({ 'label:scam': '  ' }) };
    expect(await quoteAction(event(blank), 'prompts')).toMatchObject({ status: 400 });
    expect(runs.quoteRun).not.toHaveBeenCalled();
  });

  it('refuses when the workspace page is not open to the moderator', async () => {
    access.canAccess.mockReturnValue(false);
    expect(await quoteAction(event(DRAFT), 'prompts')).toMatchObject({ status: 403 });
    expect(runs.quoteRun).not.toHaveBeenCalled();
  });

  it('refuses without a session to forward', async () => {
    session.requestCookie.mockReturnValue(null);
    expect(await quoteAction(event(DRAFT), 'prompts')).toMatchObject({ status: 401 });
    expect(runs.quoteRun).not.toHaveBeenCalled();
  });
});

describe('startAction', () => {
  it('needs a confirmed estimate', async () => {
    expect(await startAction(event(DRAFT), 'prompts')).toMatchObject({ status: 400 });
    expect(runs.startRun).not.toHaveBeenCalled();
  });

  it('starts with the stamp alone: the Buzz estimate is never taken from the form', async () => {
    expect(await startAction(event({ ...DRAFT, stamp: 's', buzz: '1' }), 'prompts')).toEqual({
      started: { startId: 'x', runIds: [5, 6], runId: 6 },
    });
    expect(runs.startRun).toHaveBeenCalledWith(
      DEPS,
      {
        setId: 3,
        workspace: 'prompts',
        draft: { prompts: { 'label:scam': 'synthetic draft' } },
        stamp: 's',
      },
      1
    );
  });

  it('refuses when the workspace page is not open to the moderator', async () => {
    access.canAccess.mockReturnValue(false);
    expect(await startAction(event({ ...DRAFT, stamp: 's' }), 'prompts')).toMatchObject({
      status: 403,
    });
    expect(runs.startRun).not.toHaveBeenCalled();
  });

  it('passes a refusal through as a form failure', async () => {
    runs.startRun.mockRejectedValue(new TestSetError('changed since the estimate', 409));
    expect(await startAction(event({ ...DRAFT, stamp: 's' }), 'prompts')).toMatchObject({
      status: 409,
      data: { error: 'changed since the estimate' },
    });
  });
});

describe('cancelAction', () => {
  it('lets the edit grant cancel anyone’s run, and anyone else only their own', async () => {
    await cancelAction(event({ setId: '3', runId: '6' }, { 'textScan.testSets.edit': true }));
    expect(runs.cancelRun).toHaveBeenCalledWith(DEPS, 3, 6, 1, true);
    await cancelAction(event({ setId: '3', runId: '6' }));
    expect(runs.cancelRun).toHaveBeenLastCalledWith(DEPS, 3, 6, 1, false);
  });

  it('refuses an unknown set and a set of a workspace the moderator cannot open', async () => {
    store.requireSet.mockRejectedValueOnce(new TestSetError('Test set 3 not found.', 404));
    expect(await cancelAction(event({ setId: '3', runId: '6' }))).toMatchObject({ status: 404 });
    access.canAccess.mockReturnValue(false);
    expect(await cancelAction(event({ setId: '3', runId: '6' }))).toMatchObject({ status: 403 });
    expect(runs.cancelRun).not.toHaveBeenCalled();
  });
});

describe('overview endpoint', () => {
  const call = (setId: string) =>
    GET({ params: { setId }, locals: { user: USER } } as unknown as Parameters<typeof GET>[0]);

  it('returns the overview and resumes runs under the viewer', async () => {
    const res = (await call('3')) as Response;
    expect(await res.json()).toEqual({ set: { id: 3 } });
    expect(reports.setOverview).toHaveBeenCalledWith(DEPS, 3);
    expect(deps.kickResume).toHaveBeenCalledWith(USER, 3);
  });

  it('404s an unknown set and 403s another workspace, resuming nothing', async () => {
    store.requireSet.mockRejectedValueOnce(new TestSetError('Test set 3 not found.', 404));
    await expect(call('3')).rejects.toMatchObject({ status: 404 });
    access.canAccess.mockReturnValue(false);
    await expect(call('3')).rejects.toMatchObject({ status: 403 });
    await expect(call('abc')).rejects.toMatchObject({ status: 404 });
    expect(deps.kickResume).not.toHaveBeenCalled();
  });

  it('401s without a session', async () => {
    session.requestCookie.mockReturnValue(null);
    await expect(call('3')).rejects.toMatchObject({ status: 401 });
    expect(deps.kickResume).not.toHaveBeenCalled();
  });
});

describe('progress endpoint', () => {
  const call = (runId: string) =>
    progress({
      params: { setId: '3', runId },
      locals: { user: USER },
    } as unknown as Parameters<typeof progress>[0]);

  it('returns the run, and 404s a run that is not in this set', async () => {
    store.getRun.mockResolvedValueOnce({ id: '6' });
    expect(await ((await call('6')) as Response).json()).toEqual({ id: 6 });
    expect(store.getRun).toHaveBeenCalledWith({}, 3, 6);
    store.getRun.mockRejectedValueOnce(new TestSetError('Run 7 not found in this set.', 404));
    await expect(call('7')).rejects.toMatchObject({ status: 404 });
  });
});

describe('case, set and re-run actions', () => {
  beforeEach(() => {
    store.updateExpectation.mockResolvedValue({ id: 9, entityType: 'CommentV2', entityId: 71 });
    store.getCase.mockResolvedValue({ id: 9, entityType: 'CommentV2', entityId: 71 });
    runs.rerunErrors.mockResolvedValue({ startId: 'y', runIds: [6], runId: 6 });
  });

  it('relabels a case, rescores the set and records the entity, not the text', async () => {
    const result = await editCaseAction(
      event({
        setId: '3',
        caseId: '9',
        expected: JSON.stringify({ scam: false }),
        note: 'looked again',
      })
    );
    expect(result).toMatchObject({ success: true });
    expect(store.updateExpectation).toHaveBeenCalledWith(
      {},
      3,
      9,
      { scam: false },
      'looked again',
      1
    );
    expect(totals.refreshSetTotals).toHaveBeenCalledWith({}, 3);
    expect(activity.recordModActivity).toHaveBeenCalledWith({
      userId: 1,
      entityType: 'CommentV2',
      entityId: 71,
      activity: 'textScan.testCase.relabel',
    });
  });

  it('records a relabel and a removal even when rescoring then fails', async () => {
    const failure = new Error('synthetic rescore failure');
    totals.refreshSetTotals.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    const relabel = event({ setId: '3', caseId: '9', expected: JSON.stringify({ scam: false }) });
    await expect(editCaseAction(relabel)).rejects.toThrow('synthetic rescore failure');
    await expect(removeCaseAction(event({ setId: '3', caseId: '9' }))).rejects.toThrow(
      'synthetic rescore failure'
    );
    for (const [n, name] of [
      [1, 'textScan.testCase.relabel'],
      [2, 'textScan.testCase.remove'],
    ] as const)
      expect(activity.recordModActivity).toHaveBeenNthCalledWith(
        n,
        expect.objectContaining({ activity: name })
      );
  });

  it('refuses a malformed expectation before writing', async () => {
    const bad = event({ setId: '3', caseId: '9', expected: '{not json' });
    expect(await editCaseAction(bad)).toMatchObject({ status: 400 });
    expect(store.updateExpectation).not.toHaveBeenCalled();
  });

  it('removes a case, rescores the set and records it', async () => {
    expect(await removeCaseAction(event({ setId: '3', caseId: '9' }))).toMatchObject({
      success: true,
    });
    expect(store.removeCase).toHaveBeenCalledWith({}, 3, 9);
    expect(totals.refreshSetTotals).toHaveBeenCalledWith({}, 3);
    expect(activity.recordModActivity).toHaveBeenCalledWith(
      expect.objectContaining({ activity: 'textScan.testCase.remove', entityId: 71 })
    );
  });

  it('refuses to remove a case that is not in the set', async () => {
    store.getCase.mockResolvedValueOnce(null);
    expect(await removeCaseAction(event({ setId: '3', caseId: '9' }))).toMatchObject({
      status: 404,
    });
    expect(store.removeCase).not.toHaveBeenCalled();
    expect(activity.recordModActivity).not.toHaveBeenCalled();
  });

  it('archives a set and records it', async () => {
    expect(await archiveSetAction(event({ setId: '3' }))).toMatchObject({ success: true });
    expect(store.archiveSet).toHaveBeenCalledWith({}, 3);
    expect(activity.recordModActivity).toHaveBeenCalledWith(
      expect.objectContaining({ activity: 'textScan.testSet.archive', entityId: 3 })
    );
  });

  it('refuses every set edit in a workspace the moderator cannot open', async () => {
    access.canAccess.mockReturnValue(false);
    const ref = { setId: '3', caseId: '9' };
    expect(await editCaseAction(event({ ...ref, expected: '{}' }))).toMatchObject({ status: 403 });
    expect(await removeCaseAction(event(ref))).toMatchObject({ status: 403 });
    expect(await archiveSetAction(event({ setId: '3' }))).toMatchObject({ status: 403 });
    expect(store.updateExpectation).not.toHaveBeenCalled();
    expect(store.removeCase).not.toHaveBeenCalled();
    expect(store.archiveSet).not.toHaveBeenCalled();
  });

  it('re-runs errors with the page grant alone, under the request session', async () => {
    expect(await rerunAction(event({ setId: '3', runId: '6' }))).toMatchObject({
      started: { runId: 6 },
    });
    expect(deps.runsDeps).toHaveBeenCalledWith('session=synthetic');
    expect(runs.rerunErrors).toHaveBeenCalledWith(DEPS, 3, 6, 1);
    // runs.ts writes the run audit; the action must not write a second one.
    expect(activity.recordModActivity).not.toHaveBeenCalled();
  });

  it('refuses a re-run without a session to forward', async () => {
    session.requestCookie.mockReturnValue(null);
    expect(await rerunAction(event({ setId: '3', runId: '6' }))).toMatchObject({ status: 401 });
    expect(runs.rerunErrors).not.toHaveBeenCalled();
  });
});
