import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The model queue's own route: its actions, and that the queue (the layout) reads nothing that changes
 * when the moderator moves between models.
 */

const getReports = vi.fn(async () => ({
  items: [] as { id: number; entityId: number | null }[],
  totalItems: 0,
  page: 1,
  limit: 20,
}));
const getOwnerFlaggedMinorModelIds = vi.fn(async (_ids: number[]) => [7]);
const getReportedModelId = vi.fn();
const setReportStatus = vi.fn();
vi.mock('$lib/server/reports.service', () => ({
  getReports,
  getReportStatusCounts: vi.fn(async () => ({})),
  setReportStatus,
  updateReportNotes: vi.fn(),
  getReportedModelId,
  getReportedModelStates: vi.fn(async () => []),
  getOwnerFlaggedMinorModelIds,
}));
const modelActions = {
  unpublishReportedModel: vi.fn(),
  takeDownReportedModel: vi.fn(),
  bringBackReportedModel: vi.fn(),
  setReportedModelSfwOnly: vi.fn(),
  setReportedModelPoi: vi.fn(),
  setReportedModelMinor: vi.fn(),
  unsetReportedModelMinor: vi.fn(),
};
vi.mock('$lib/server/model-moderation.service', () => modelActions);
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/users.service', () => ({ MAX_INT4: 2_147_483_647 }));
const canAccess = vi.fn(() => true);
vi.mock('$lib/server/access', () => ({ canAccess, canViewTrainingData: () => true }));
const MERGE_CHECKS = { 501: { sourceModelId: 115 } };
const getMergePermissionChecks = vi.fn(async (_reports: unknown[]) => MERGE_CHECKS);
vi.mock('$lib/server/merge-permission.service', () => ({ getMergePermissionChecks }));

const { modelQueueActions } = await import('../actions.server');
const { load: layoutLoad } = await import('../+layout.server');
const { load: indexLoad, actions: indexActions } = await import('../+page.server');
const { load: modelLoad, actions: modelPageActions } = await import('../[modelId]/+page.server');

let grants: Record<string, true> = {};
const event = (form: Record<string, string> = {}) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(form)) data.append(key, value);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 7 }, grants },
    getClientAddress: () => '203.0.113.9',
  } as never;
};
const failure = (result: unknown) => {
  const r = result as { status: number; data: { error: string } };
  return { status: r.status, error: r.data.error };
};
const locals = { user: { id: 1 }, grants: {} };
const url = (path: string) => new URL(`https://mod.example${path}`);
const thrown = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return e as { status: number; location?: string };
  }
  throw new Error('expected a throw');
};

beforeEach(() => {
  vi.clearAllMocks();
  grants = {};
  canAccess.mockReturnValue(true);
});

describe('the queue layout', () => {
  // SvelteKit reruns a load whose tracked URL reads changed. `get`/`getAll`/`has` are tracked per key;
  // iterating the query string or reading the path makes the queue rerun on every model click.
  it('reads only its own params, never the whole query or the path', async () => {
    const real = url('/reports/model/5?status=Pending');
    const touched: string[] = [];
    const searchParams = new Proxy(real.searchParams, {
      get(target, key) {
        if (key === 'get' || key === 'getAll' || key === 'has')
          return (k: string) => {
            touched.push(k);
            return (target[key] as (k: string) => unknown).call(target, k);
          };
        throw new Error(`searchParams.${String(key)} reads the whole query string`);
      },
    });
    const tracked = new Proxy(real, {
      get(target, key) {
        if (key === 'searchParams') return searchParams;
        throw new Error(`url.${String(key)} is tracked as a whole`);
      },
    });

    await layoutLoad({
      url: tracked,
      locals,
      params: new Proxy(
        {},
        {
          get: () => {
            throw new Error('params read');
          },
        }
      ),
    } as never);
    expect(touched).toContain('status');
    expect(touched).not.toContain('model');
  });

  it('leaves a bare landing bare: the default statuses are not written into the URL', async () => {
    const data = await layoutLoad({ url: url('/reports/model'), locals } as never);
    expect(data).toMatchObject({ statuses: ['Pending', 'Processing'] });
    expect(getReports).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ['Pending', 'Processing'] })
    );
  });

  it("looks up the page's model ids and hands the owner-flagged ones to the page", async () => {
    getReports.mockResolvedValueOnce({
      items: [7, null, 8].map((entityId, i) => ({ id: i + 1, entityId })),
      totalItems: 3,
      page: 1,
      limit: 20,
    });
    const data = await layoutLoad({ url: url('/reports/model?status=Pending'), locals } as never);

    expect(getOwnerFlaggedMinorModelIds).toHaveBeenCalledExactlyOnceWith([7, 8]);
    expect(data).toMatchObject({ ownerFlaggedMinor: [7], fullBleed: true });
  });
});

describe('setStatus', () => {
  // Every status, Pending and Processing included, unlike the user queue — until it is settled whether
  // Processing still marks an ownership claim under investigation.
  it.each(['Pending', 'Processing', 'Actioned', 'Unactioned'])('sets %s', async (status) => {
    setReportStatus.mockResolvedValue({ ok: true, changed: true });
    expect(await modelQueueActions.setStatus(event({ id: '55', status }))).toEqual({
      success: true,
    });
    expect(setReportStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 55, status }));
  });
});

describe('the pages', () => {
  it('both take the model queue actions', () => {
    expect(Object.keys(indexActions).sort()).toEqual(Object.keys(modelQueueActions).sort());
    expect(Object.keys(modelPageActions).sort()).toEqual(Object.keys(modelQueueActions).sort());
    expect(Object.keys(modelQueueActions).sort()).toEqual([
      'moderateModel',
      'saveNotes',
      'setStatus',
    ]);
  });

  // "Was this merge allowed when it was made?" — for the model's own reports, and for the queue's rows,
  // since the open model also lists any of its reports the queue is showing.
  it('checks merge permission for the open model and for the queue', async () => {
    const reports = [{ id: 501, entityId: 42, details: {} }];
    getReports.mockResolvedValueOnce({ items: reports, totalItems: 1, page: 1, limit: 100 });
    const data = (await modelLoad({ params: { modelId: '42' } } as never)) as {
      item: { mergePermission: unknown };
    };
    expect(getMergePermissionChecks).toHaveBeenCalledWith([expect.objectContaining({ id: 501 })]);
    expect(data.item.mergePermission).toEqual(MERGE_CHECKS);

    getMergePermissionChecks.mockClear();
    getReports.mockResolvedValueOnce({ items: reports, totalItems: 1, page: 1, limit: 20 });
    const layout = await layoutLoad({ url: url('/reports/model'), locals } as never);
    expect(getMergePermissionChecks).toHaveBeenCalledWith([expect.objectContaining({ id: 501 })]);
    expect(layout).toMatchObject({ mergePermission: MERGE_CHECKS });
  });

  it('a path that is not a model id is a 404', async () => {
    expect((await thrown(() => modelLoad({ params: { modelId: 'abc' } } as never))).status).toBe(
      404
    );
  });

  // Every open report on the model, by the model — not the ones on the current page of the queue,
  // where a second report could sit a page away and go unruled.
  it("loads the model's own open reports, its state and its owner's minor flag", async () => {
    getReports.mockResolvedValueOnce({
      items: [{ id: 9, entityId: 42 }],
      totalItems: 1,
      page: 1,
      limit: 100,
    });
    getOwnerFlaggedMinorModelIds.mockResolvedValueOnce([42]);
    const data = (await modelLoad({ params: { modelId: '42' } } as never)) as {
      item: { modelId: number; reports: unknown[]; ownerFlaggedMinor: boolean };
    };

    expect(getReports).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'model',
        entityId: 42,
        statuses: ['Pending', 'Processing'],
      })
    );
    expect(data.item).toMatchObject({ modelId: 42, ownerFlaggedMinor: true });
    expect(data.item.reports).toHaveLength(1);
  });

  it('the bare queue opens its first model', async () => {
    const parent = async () => ({
      items: [
        { id: 1, entityId: null },
        { id: 2, entityId: 77 },
      ],
    });
    const data = (await indexLoad({ url: url('/reports/model'), parent } as never)) as {
      item: { modelId: number } | null;
    };
    expect(data.item?.modelId).toBe(77);
  });

  it('the old ?model= moves into the path and keeps the rest', async () => {
    const r = await thrown(() =>
      indexLoad({ url: url('/reports/model?model=42&status=Pending') } as never)
    );
    expect(r).toMatchObject({ status: 308, location: '/reports/model/42?status=Pending' });
  });
});

describe('moderateModel action', () => {
  const moderate = (form: Record<string, string>) =>
    modelQueueActions.moderateModel(event({ id: '55', ...form }));

  beforeEach(() => {
    grants = { 'model.takeDown': true };
    getReportedModelId.mockResolvedValue(4201);
    for (const fn of Object.values(modelActions)) fn.mockResolvedValue({ ok: true });
  });

  it('acts on the model the REPORT names, and never touches the report', async () => {
    // A posted modelId is ignored: a stale tab must not act on one model while a moderator believes
    // they are looking at another.
    const result = await moderate({ modelAction: 'takeDown', modelId: '99' });

    expect(getReportedModelId).toHaveBeenCalledWith(55);
    expect(modelActions.takeDownReportedModel).toHaveBeenCalledWith(4201);
    // Closing the report is the Report status buttons' job. Actioned pays the reporters, which must
    // not happen as a side effect of a model button.
    expect(setReportStatus).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, moderated: 'Taken down model #4201' });
  });

  it.each([
    ['setMinor', 'setReportedModelMinor', [4201], 'Flagged as minor'],
    ['unsetMinor', 'unsetReportedModelMinor', [4201], 'Unflagged as minor'],
    ['setSfwOnly', 'setReportedModelSfwOnly', [4201, true], 'Set as SFW-only'],
    ['unsetSfwOnly', 'setReportedModelSfwOnly', [4201, false], 'Allowed NSFW on'],
    ['setPoi', 'setReportedModelPoi', [4201, true], 'Flagged as a real person'],
    ['unsetPoi', 'setReportedModelPoi', [4201, false], 'Unflagged as a real person'],
    ['bringBack', 'bringBackReportedModel', [4201], 'Brought back'],
  ] as const)('%s calls %s', async (modelAction, fn, args, done) => {
    const result = await moderate({ modelAction });
    expect(modelActions[fn]).toHaveBeenCalledWith(...args);
    expect(result).toEqual({ success: true, moderated: `${done} model #4201` });
  });

  it.each(['takeDown', 'bringBack'])(
    '%s needs model.takeDown — both directions, one grant',
    async (modelAction) => {
      grants = {};
      expect(failure(await moderate({ modelAction }))).toEqual({
        status: 403,
        error: 'This action requires the “Take down a model (ownership / claim)” permission.',
      });
      expect(modelActions.takeDownReportedModel).not.toHaveBeenCalled();
      expect(modelActions.bringBackReportedModel).not.toHaveBeenCalled();
    }
  );

  it('has no republish: undoing a violation unpublish is an appeal, not a report button', async () => {
    expect(failure(await moderate({ modelAction: 'republish' })).status).toBe(400);
  });

  it('has no delete: a report is answered by taking a model down, never by destroying it', async () => {
    expect(failure(await moderate({ modelAction: 'delete' })).status).toBe(400);
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('passes a refusal from the main app straight through', async () => {
    modelActions.takeDownReportedModel.mockResolvedValue({
      ok: false,
      error: 'Take down returned 500.',
    });

    expect(failure(await moderate({ modelAction: 'takeDown' }))).toEqual({
      status: 400,
      error: 'Take down returned 500.',
    });
  });

  it('flags as minor only for a minor reason the moderator left ticked', async () => {
    await moderate({ modelAction: 'unpublish', reason: 'mature-underage', alsoFlagMinor: 'on' });
    expect(modelActions.unpublishReportedModel).toHaveBeenLastCalledWith({
      modelId: 4201,
      reason: 'mature-underage',
      customMessage: undefined,
      alsoFlagMinor: true,
    });

    // A forged tick on a reason that says nothing about minors is dropped.
    await moderate({ modelAction: 'unpublish', reason: 'spam', alsoFlagMinor: 'on' });
    expect(modelActions.unpublishReportedModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'spam', alsoFlagMinor: false })
    );
  });

  it('refuses an unpublish without a reason, or "other" without a message', async () => {
    expect(failure(await moderate({ modelAction: 'unpublish', reason: 'bogus' })).status).toBe(400);
    expect(failure(await moderate({ modelAction: 'unpublish', reason: 'other' })).status).toBe(400);
    expect(modelActions.unpublishReportedModel).not.toHaveBeenCalled();
  });

  it("needs the model queue, and refuses a report that is not a model's", async () => {
    canAccess.mockReturnValue(false);
    expect(failure(await moderate({ modelAction: 'takeDown' })).status).toBe(403);
    canAccess.mockReturnValue(true);
    getReportedModelId.mockResolvedValue(null);
    expect(failure(await moderate({ modelAction: 'takeDown' })).status).toBe(410);
    expect(modelActions.takeDownReportedModel).not.toHaveBeenCalled();
  });
});
