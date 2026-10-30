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
const canAccess = vi.fn(() => true);

const getReportedGame = vi.fn();
vi.mock('$lib/server/reports.service', () => ({
  getReports,
  getReportStatusCounts: vi.fn(async () => ({})),
  setReportStatus,
  updateReportNotes,
  getReportedGame,
  getGameMirrors: vi.fn(async () => []),
}));
const delistGame = vi.fn();
vi.mock('$lib/server/game-frame', async (importOriginal) => ({
  ...(await importOriginal<typeof GameFrame>()),
  delistGame,
}));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
// Imports the main-app client (`$app/server`, private env), which nothing else in this graph loads.
vi.mock('$lib/server/storyline-scan-lift.service', () => ({ liftStorylineScanTakedown: vi.fn() }));
// Stubbed for a different reason than the others: no database, but `canAccess` reads a grants store
// only the request hook fills, so the real one answers false for everything here.
vi.mock('$lib/server/access', () => ({ canAccess }));

const { actions } = await import('../+page.server');

const MOD = { id: 7 };
/** The actor's resolved permissions; reset per test, so a grant cannot leak into the next case. */
let grants: Record<string, true> = {};

/**
 * A REAL `FormData`, not a Map: `Map.get` gives `undefined` where `FormData.get` gives `null`, and
 * `Number()` maps those to NaN and 0 — opposite sides of an action's `Number.isInteger` check.
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
