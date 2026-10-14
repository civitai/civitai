import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportStatus } from '$lib/reports';
import type * as GameFrame from '$lib/server/game-frame';

/**
 * What only the action layer decides: that a service outcome is TRANSLATED rather than discarded.
 * Discarding it is the defect the actions' own comments record — success for a report someone else
 * had already actioned, and "actioned N of N" for a run that changed nothing.
 */

const setReportStatus = vi.fn();
const getReports = vi.fn(async () => ({ items: [], totalItems: 0, page: 1, limit: 20 }));
const updateReportNotes = vi.fn();
const getResolvedPostReportIds = vi.fn(async () => [] as number[]);
const removePlacement = vi.fn();
const canAccess = vi.fn(() => true);

const getReportedGame = vi.fn();
const getReportedModelId = vi.fn();
vi.mock('$lib/server/reports.service', () => ({
  getReports,
  setReportStatus,
  updateReportNotes,
  getReportedGame,
  getReportedModelId,
  getReportedModelStates: vi.fn(async () => []),
  getGameMirrors: vi.fn(async () => []),
}));
vi.mock('$lib/server/moderation-board.service', () => ({ getResolvedPostReportIds }));
vi.mock('$lib/server/user-actions.service', () => ({ removePlacement }));
const modelActions = {
  unpublishReportedModel: vi.fn(),
  takeDownReportedModel: vi.fn(),
  bringBackReportedModel: vi.fn(),
  setReportedModelSfwOnly: vi.fn(),
  setReportedModelMinor: vi.fn(),
  unsetReportedModelMinor: vi.fn(),
};
vi.mock('$lib/server/model-moderation.service', () => modelActions);
const delistGame = vi.fn();
vi.mock('$lib/server/game-frame', async (importOriginal) => ({
  ...(await importOriginal<typeof GameFrame>()),
  delistGame,
}));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
// Stubbed for a different reason than the others: no database, but `canAccess` reads a grants store
// only the request hook fills, so the real one answers false for everything here.
vi.mock('$lib/server/access', () => ({ canAccess }));

const { actions } = await import('../+page.server');

const MOD = { id: 7 };
/** The actor's resolved permissions; reset per test, so a grant cannot leak into the next case. */
let grants: Record<string, true> = {};

/**
 * A REAL `FormData`, not a Map: `Map.get` gives `undefined` where `FormData.get` gives `null`, and
 * `Number()` maps those to NaN and 0 — opposite sides of `removePlacement`'s `Number.isInteger`.
 */
const event = (form: Record<string, string> = {}, slug = 'image') => {
  const data = new FormData();
  for (const [key, value] of Object.entries(form)) data.append(key, value);
  return {
    request: { formData: async () => data },
    locals: { user: MOD, grants },
    params: { slug },
    getClientAddress: () => '203.0.113.9',
  } as never;
};

/** A `fail()` result, unwrapped to the shape an action test cares about. */
const failure = (result: unknown) => {
  const r = result as { status: number; data: { error: string } };
  return { status: r.status, error: r.data.error };
};

beforeEach(() => {
  vi.clearAllMocks();
  grants = {};
  canAccess.mockReturnValue(true);
  setReportStatus.mockResolvedValue({ ok: true, changed: true });
  updateReportNotes.mockResolvedValue({ ok: true });
});

describe('setStatus action', () => {
  it('actions a report and reports success', async () => {
    const result = await actions.setStatus(event({ id: '42', status: ReportStatus.Actioned }));

    expect(setReportStatus).toHaveBeenCalledWith({
      id: 42,
      status: ReportStatus.Actioned,
      userId: 7,
      ip: '203.0.113.9',
    });
    expect(result).toEqual({ success: true });
  });

  it('surfaces a 410 gone when the report vanished, rather than reporting success', async () => {
    setReportStatus.mockResolvedValue({
      ok: false,
      error: 'That report no longer exists. Reload.',
    });

    const result = await actions.setStatus(event({ id: '42', status: ReportStatus.Actioned }));

    // `gone` is what makes the page reload; a bare message would render and change nothing.
    expect(failure(result)).toEqual({
      status: 410,
      error: 'That report no longer exists. Reload.',
    });
    expect((result as { data: { gone?: boolean } }).data.gone).toBe(true);
  });

  it('surfaces a 409 when another moderator already set that status', async () => {
    setReportStatus.mockResolvedValue({ ok: true, changed: false });

    const result = await actions.setStatus(event({ id: '42', status: ReportStatus.Actioned }));

    expect(failure(result).status).toBe(409);
  });

  it('rejects a status that is not a real ReportStatus without reaching the service', async () => {
    const result = await actions.setStatus(event({ id: '42', status: 'Deleted' }));

    expect(failure(result).status).toBe(400);
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('rejects a missing id without reaching the service', async () => {
    const result = await actions.setStatus(event({ status: ReportStatus.Actioned }));

    expect(failure(result).status).toBe(400);
    expect(setReportStatus).not.toHaveBeenCalled();
  });
});

describe('actionResolvedPosts action', () => {
  it('counts what actually changed, not how many ids it looped over', async () => {
    getResolvedPostReportIds.mockResolvedValue([1, 2, 3]);
    setReportStatus
      .mockResolvedValueOnce({ ok: true, changed: true })
      .mockResolvedValueOnce({ ok: true, changed: false })
      .mockResolvedValueOnce({ ok: false, error: 'gone' });

    const result = await actions.actionResolvedPosts(event());

    expect(result).toMatchObject({ success: true, actioned: 1, skipped: 2, found: 3 });
  });

  it('sweeps as Actioned — the content was removed, so the reports were right', async () => {
    getResolvedPostReportIds.mockResolvedValue([1]);

    await actions.actionResolvedPosts(event());

    expect(setReportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: ReportStatus.Actioned })
    );
  });

  it('flags a full batch as probably having more behind it', async () => {
    getResolvedPostReportIds.mockResolvedValue(Array.from({ length: 500 }, (_, i) => i + 1));

    const result = await actions.actionResolvedPosts(event());

    expect(result).toMatchObject({ more: true, found: 500 });
  });

  it('does not claim a sweep when there was nothing to sweep', async () => {
    getResolvedPostReportIds.mockResolvedValue([]);

    const result = await actions.actionResolvedPosts(event());

    expect(failure(result).status).toBe(400);
    expect(setReportStatus).not.toHaveBeenCalled();
  });
});

describe('removePlacement action', () => {
  it('is gated on /reports even though the page load is not', async () => {
    canAccess.mockReturnValue(false);

    const result = await actions.removePlacement(event({ placementId: '5' }));

    expect(canAccess).toHaveBeenCalledWith(MOD, '/reports');
    expect(failure(result).status).toBe(403);
    expect(removePlacement).not.toHaveBeenCalled();
  });

  it('delegates to the service so escrow settles in one place', async () => {
    removePlacement.mockResolvedValue({ ok: true });

    const result = await actions.removePlacement(event({ placementId: '5' }));

    expect(removePlacement).toHaveBeenCalledWith({ placementId: 5, moderatorId: 7 });
    expect(result).toMatchObject({ success: true, placementRemoved: 5 });
  });

  it('rejects a non-positive placement id without reaching the service', async () => {
    const result = await actions.removePlacement(event({ placementId: '0' }));

    expect(failure(result).status).toBe(400);
    expect(removePlacement).not.toHaveBeenCalled();
  });

  it('rejects a missing placement id — absent reads as 0, not as NaN', async () => {
    const result = await actions.removePlacement(event());

    expect(failure(result).status).toBe(400);
    expect(removePlacement).not.toHaveBeenCalled();
  });

  it('surfaces an escrow failure rather than reporting the placement removed', async () => {
    // A refusal here is money that did not move.
    removePlacement.mockResolvedValue({ ok: false, error: 'Escrow already settled.' });

    const result = await actions.removePlacement(event({ placementId: '5' }));

    expect(failure(result)).toEqual({ status: 400, error: 'Escrow already settled.' });
  });
});

describe('saveNotes action', () => {
  it('persists the notes it was given', async () => {
    const result = await actions.saveNotes(event({ id: '42', internalNotes: '  spam ring  ' }));

    expect(updateReportNotes).toHaveBeenCalledWith({ id: 42, internalNotes: 'spam ring' });
    expect(result).toEqual({ success: true });
  });

  it('stores empty notes as null rather than an empty string', async () => {
    await actions.saveNotes(event({ id: '42', internalNotes: '   ' }));

    expect(updateReportNotes).toHaveBeenCalledWith({ id: 42, internalNotes: null });
  });

  it('rejects a missing id without reaching the service', async () => {
    const result = await actions.saveNotes(event({ internalNotes: 'x' }));

    expect(failure(result).status).toBe(400);
    expect(updateReportNotes).not.toHaveBeenCalled();
  });

  it('reports notes that were never stored, rather than a green save over nothing', async () => {
    updateReportNotes.mockResolvedValue({ ok: false, gone: true });

    const result = await actions.saveNotes(event({ id: '42', internalNotes: 'spam ring' }));

    expect(failure(result).status).toBe(410);
    expect((result as { data: { gone?: boolean } }).data.gone).toBe(true);
  });
});

describe('delistGame action', () => {
  const game = { slug: 'kraken-cove', reason: 'TOSViolation', violation: 'Hate or harassment' };
  const delist = (form: Record<string, string> = { id: '991' }, slug = 'game') =>
    actions.delistGame(event(form, slug));

  beforeEach(() => getReportedGame.mockResolvedValue(game));

  it('delists, then sets the report Actioned and names the forks', async () => {
    delistGame.mockResolvedValue({ ok: true, affected: 2 });

    const result = await delist();

    expect(delistGame).toHaveBeenCalledWith({
      slug: 'kraken-cove',
      reason: 'Reported: Hate or harassment; report #991',
      reportId: 991,
      moderator: { id: 7, username: null },
    });
    expect(setReportStatus).toHaveBeenCalledWith({
      id: 991,
      status: ReportStatus.Actioned,
      userId: 7,
      ip: '203.0.113.9',
    });
    expect(result).toEqual({ success: true, delisted: 'Delisted (+2 forks)' });
  });

  it('leaves the report untouched when Game Frame refuses', async () => {
    delistGame.mockResolvedValue({
      ok: false,
      status: 502,
      message: 'Game Frame refused the delist (config).',
    });

    expect(failure(await delist())).toEqual({
      status: 502,
      error: 'Game Frame refused the delist (config).',
    });
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('only runs on the game queue, and only for a moderator with access to it', async () => {
    expect(failure(await delist({ id: '991' }, 'image')).status).toBe(403);
    canAccess.mockReturnValue(false);
    expect(failure(await delist()).status).toBe(403);
    expect(delistGame).not.toHaveBeenCalled();
  });

  it('refuses a report that is not about a game without calling Game Frame', async () => {
    getReportedGame.mockResolvedValue(null);
    expect(failure(await delist()).status).toBe(410);
    expect(delistGame).not.toHaveBeenCalled();
  });
});

describe('moderateModel action', () => {
  const moderate = (form: Record<string, string>, slug = 'model') =>
    actions.moderateModel(event({ id: '55', ...form }, slug));

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
    ['bringBack', 'bringBackReportedModel', [4201], 'Brought back'],
  ] as const)('%s calls %s', async (modelAction, fn, args, done) => {
    const result = await moderate({ modelAction });
    expect(modelActions[fn]).toHaveBeenCalledWith(...args);
    expect(result).toEqual({ success: true, moderated: `${done} model #4201` });
  });

  it.each(['takeDown', 'bringBack'])('%s needs model.takeDown — both directions, one grant', async (modelAction) => {
    grants = {};
    expect(failure(await moderate({ modelAction }))).toEqual({
      status: 403,
      error: 'This action requires the “Take down a model (ownership / claim)” permission.',
    });
    expect(modelActions.takeDownReportedModel).not.toHaveBeenCalled();
    expect(modelActions.bringBackReportedModel).not.toHaveBeenCalled();
  });

  it('has no republish: undoing a violation unpublish is an appeal, not a report button', async () => {
    expect(failure(await moderate({ modelAction: 'republish' })).status).toBe(400);
  });

  it('has no delete: a report is answered by taking a model down, never by destroying it', async () => {
    expect(failure(await moderate({ modelAction: 'delete' })).status).toBe(400);
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('passes a refusal from the main app straight through', async () => {
    modelActions.takeDownReportedModel.mockResolvedValue({ ok: false, error: 'Take down returned 500.' });

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

  it("only runs on the model queue, and refuses a report that is not a model's", async () => {
    expect(failure(await moderate({ modelAction: 'takeDown' }, 'image')).status).toBe(403);
    getReportedModelId.mockResolvedValue(null);
    expect(failure(await moderate({ modelAction: 'takeDown' })).status).toBe(410);
    expect(modelActions.takeDownReportedModel).not.toHaveBeenCalled();
  });
});
