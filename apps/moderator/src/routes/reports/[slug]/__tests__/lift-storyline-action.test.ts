import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The storyline report sheet's "Lift takedown" action: what it refuses before calling the main app,
 * and that the main app's refusal reaches the moderator. The lift itself, and its guards, are the
 * main app's `moderateStorylineTitle`.
 */

const { getReportStorylineId, liftStorylineScanTakedown, canAccess } = vi.hoisted(() => ({
  getReportStorylineId: vi.fn(),
  liftStorylineScanTakedown: vi.fn(),
  canAccess: vi.fn(() => true),
}));

vi.mock('$lib/server/reports.service', () => ({
  getReports: vi.fn(),
  getReportStatusCounts: vi.fn(async () => ({})),
  setReportStatus: vi.fn(),
  updateReportNotes: vi.fn(),
  getReportedGame: vi.fn(),
  getGameMirrors: vi.fn(async () => []),
}));
vi.mock('$lib/server/moderation-board.service', () => ({ getResolvedPostReportIds: vi.fn() }));
vi.mock('$lib/server/user-actions.service', () => ({ removePlacement: vi.fn() }));
vi.mock('$lib/server/game-frame', () => ({ delistGame: vi.fn(), delistReason: vi.fn() }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/model-moderation.service', () => ({}));
vi.mock('$lib/server/storyline-takedown.service', () => ({
  getReportedStorylines: vi.fn(async () => []),
  getReportStorylineId,
  setStorylineTakedown: vi.fn(),
}));
vi.mock('$lib/server/storyline-scan-lift.service', () => ({ liftStorylineScanTakedown }));
vi.mock('$lib/server/service-offering-takedown.service', () => ({
  getReportedServiceOfferings: vi.fn(async () => []),
  getReportServiceOfferingId: vi.fn(),
  takedownServiceOffering: vi.fn(),
}));
vi.mock('$lib/server/access', () => ({ canAccess }));

const { actions } = await import('../+page.server');

const MOD = 7;
const lift = (fields: Record<string, string>, slug = 'storyline') => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return (actions.liftStorylineScanTakedown as (event: unknown) => Promise<unknown>)({
    request: new Request('https://mod.example/reports/storyline', { method: 'POST', body }),
    locals: { user: { id: MOD } },
    params: { slug },
  });
};
const fields = { id: '42', reviewedTitle: 'The title I read' };
const failure = (result: unknown) => {
  const r = result as { status: number; data: { error: string } };
  return { status: r.status, error: r.data.error };
};

beforeEach(() => {
  vi.clearAllMocks();
  canAccess.mockReturnValue(true);
  getReportStorylineId.mockResolvedValue(10);
});

describe('lifting a title-scan takedown from the storyline report sheet', () => {
  it('lifts for the title the form carries, as the acting moderator', async () => {
    liftStorylineScanTakedown.mockResolvedValue({ ok: true, tosViolation: false });

    const result = await lift(fields);

    expect(liftStorylineScanTakedown).toHaveBeenCalledExactlyOnceWith({
      storylineId: 10,
      reviewedTitle: 'The title I read',
      moderatorId: MOD,
    });
    expect(result).toEqual({ success: true, storylineTakedown: 'Lifted' });
  });

  it("says when a moderator's takedown keeps it down", async () => {
    liftStorylineScanTakedown.mockResolvedValue({ ok: true, tosViolation: true });

    expect(await lift(fields)).toEqual({
      success: true,
      storylineTakedown: "Lifted the title scan's takedown; a moderator's takedown keeps it down",
    });
  });

  // A refusal swallowed here would read as a lift.
  it("shows the main app's refusal", async () => {
    liftStorylineScanTakedown.mockResolvedValue({
      ok: false,
      error: 'Lift takedown: The title has changed since it was reviewed',
    });

    expect(failure(await lift(fields))).toEqual({
      status: 409,
      error: 'Lift takedown: The title has changed since it was reviewed',
    });
  });

  it('is gone for a vanished report', async () => {
    getReportStorylineId.mockResolvedValue(null);
    expect(failure(await lift(fields)).status).toBe(410);
    expect(liftStorylineScanTakedown).not.toHaveBeenCalled();
  });

  it.each([
    ['without a title', { id: '42' }, 'storyline', 400],
    ['without a report id', { ...fields, id: 'x' }, 'storyline', 400],
    ['from another queue', fields, 'image', 403],
  ])('lifts nothing %s', async (_label, form, slug, expected) => {
    expect(failure(await lift(form, slug)).status).toBe(expected);
    expect(liftStorylineScanTakedown).not.toHaveBeenCalled();
  });

  it('lifts nothing for a moderator without access to the storyline queue', async () => {
    canAccess.mockReturnValue(false);
    expect(failure(await lift(fields)).status).toBe(403);
    expect(liftStorylineScanTakedown).not.toHaveBeenCalled();
  });
});
