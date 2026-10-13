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
  resumeRuns: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/text-scan-tests/deps', () => deps);

const access = vi.hoisted(() => ({ canAccess: vi.fn(() => true) }));
vi.mock('$lib/server/access', async (importOriginal) => ({
  ...(await importOriginal<typeof Access>()),
  ...access,
}));
const runs = vi.hoisted(() => ({ quoteRun: vi.fn(), startRun: vi.fn(), cancelRun: vi.fn() }));
vi.mock('$lib/server/text-scan-tests/runs', async (importOriginal) => ({
  ...(await importOriginal<typeof Runs>()),
  ...runs,
}));
const store = vi.hoisted(() => ({ getSet: vi.fn() }));
vi.mock('$lib/server/text-scan-tests/store', async (importOriginal) => ({
  ...(await importOriginal<typeof Store>()),
  ...store,
}));
const reports = vi.hoisted(() => ({ setOverview: vi.fn() }));
vi.mock('$lib/server/text-scan-tests/reports', () => reports);

const { cancelAction, quoteAction, startAction } = await import('../text-scan-tests/form-actions');
const { TestSetError } = await import('../text-scan-tests/store');
const { GET } = await import('../../../routes/text-scan/test-sets/[setId]/overview/+server');

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
  rules: '[]',
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
  store.getSet.mockResolvedValue({ id: 3, workspace: 'prompts' });
  reports.setOverview.mockResolvedValue({ set: { id: 3 } });
});

describe('quoteAction', () => {
  it('quotes with the page grant alone, under the request session, passing the draft', async () => {
    expect(await quoteAction(event(DRAFT), 'prompts')).toEqual({ quote: { calls: 2, stamp: 's' } });
    expect(deps.runsDeps).toHaveBeenCalledWith('session=synthetic');
    expect(runs.quoteRun).toHaveBeenCalledWith(DEPS, 3, 'prompts', {
      prompts: { 'label:scam': 'synthetic draft' },
      rules: [],
    });
  });

  it('passes no draft when nothing is edited', async () => {
    await quoteAction(event({ setId: '3', prompts: '{}', rules: '[]' }), 'prompts');
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
        draft: { prompts: { 'label:scam': 'synthetic draft' }, rules: [] },
        stamp: 's',
      },
      1
    );
  });

  it('refuses when the workspace page is not open to the moderator', async () => {
    access.canAccess.mockReturnValue(false);
    expect(await startAction(event({ ...DRAFT, stamp: 's' }), 'modelRules')).toMatchObject({
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
    store.getSet.mockResolvedValueOnce(null);
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
    expect(deps.resumeRuns).toHaveBeenCalledWith(USER);
  });

  it('404s an unknown set and 403s another workspace, resuming nothing', async () => {
    store.getSet.mockResolvedValueOnce(null);
    await expect(call('3')).rejects.toMatchObject({ status: 404 });
    access.canAccess.mockReturnValue(false);
    await expect(call('3')).rejects.toMatchObject({ status: 403 });
    await expect(call('abc')).rejects.toMatchObject({ status: 404 });
    expect(deps.resumeRuns).not.toHaveBeenCalled();
  });

  it('401s without a session', async () => {
    session.requestCookie.mockReturnValue(null);
    await expect(call('3')).rejects.toMatchObject({ status: 401 });
  });
});
