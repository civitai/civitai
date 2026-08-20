import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportStatus } from '$lib/reports';

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

vi.mock('$lib/server/reports.service', () => ({
  getReports,
  setReportStatus,
  updateReportNotes,
}));
vi.mock('$lib/server/moderation-board.service', () => ({ getResolvedPostReportIds }));
vi.mock('$lib/server/user-actions.service', () => ({ removePlacement }));
// Stubbed for a different reason than the others: no database, but `canAccess` reads a grants store
// only the request hook fills, so the real one answers false for everything here.
vi.mock('$lib/server/access', () => ({ canAccess }));

const { actions } = await import('../+page.server');

const MOD = { id: 7 };

/**
 * A REAL `FormData`, not a Map: `Map.get` gives `undefined` where `FormData.get` gives `null`, and
 * `Number()` maps those to NaN and 0 — opposite sides of `removePlacement`'s `Number.isInteger`.
 */
const event = (form: Record<string, string> = {}) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(form)) data.append(key, value);
  return {
    request: { formData: async () => data },
    locals: { user: MOD },
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
