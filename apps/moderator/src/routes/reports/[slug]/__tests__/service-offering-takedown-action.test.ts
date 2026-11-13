import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The report queue's "Take down service" action: what it refuses before touching anything, and that
 * a takedown actions the report. The write itself is pinned on the real SQL in
 * service-offering-takedown.pglite.test.ts.
 */

const { setReportStatus, takedownServiceOffering, getReportServiceOfferingId } = vi.hoisted(() => ({
  setReportStatus: vi.fn(async () => ({ ok: true })),
  takedownServiceOffering: vi.fn(async () => ({ changed: true })),
  getReportServiceOfferingId: vi.fn(async () => 5),
}));

vi.mock('$lib/server/reports.service', () => ({
  getReports: vi.fn(),
  getReportStatusCounts: vi.fn(async () => ({})),
  setReportStatus,
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
  getReportStorylineId: vi.fn(),
  setStorylineTakedown: vi.fn(),
}));
vi.mock('$lib/server/service-offering-takedown.service', () => ({
  getReportedServiceOfferings: vi.fn(async () => []),
  getReportServiceOfferingId,
  takedownServiceOffering,
}));
vi.mock('$lib/server/access', () => ({ canAccess: vi.fn(() => true) }));

const { actions } = await import('../+page.server');

const MOD = 42;
const takeDown = (fields: Record<string, string>, slug = 'service') => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return (actions.takeDownServiceOffering as (event: unknown) => Promise<unknown>)({
    request: new Request('https://mod.example/reports/service', { method: 'POST', body }),
    locals: { user: { id: MOD } },
    params: { slug },
    getClientAddress: () => '127.0.0.1',
  });
};
const status = (result: unknown) => (result as { status?: number }).status;

beforeEach(() => vi.clearAllMocks());

describe('taking down a reported service', () => {
  it('takes it down with the reason and trimmed details, then actions the report', async () => {
    const result = await takeDown({ id: '9', reason: 'off-platform', details: '  pay me on X  ' });
    expect(takedownServiceOffering).toHaveBeenCalledWith({
      offeringId: 5,
      reason: 'off-platform',
      details: 'pay me on X',
      moderatorId: MOD,
    });
    expect(setReportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9, status: 'Actioned', userId: MOD })
    );
    expect(result).toEqual({ success: true, serviceOfferingTakedown: 'Taken down' });
  });

  it.each([
    ['a missing reason', { id: '9' }],
    ['an unknown reason', { id: '9', reason: 'not-a-reason' }],
    ['a prototype key as a reason', { id: '9', reason: 'toString' }],
    ['other with no details', { id: '9', reason: 'other', details: '   ' }],
    ['a bad report id', { id: 'x', reason: 'spam' }],
  ])('refuses %s and touches nothing', async (_, fields) => {
    expect(status(await takeDown(fields))).toBe(400);
    expect(takedownServiceOffering).not.toHaveBeenCalled();
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('refuses on any queue but the service one', async () => {
    expect(status(await takeDown({ id: '9', reason: 'spam' }, 'storyline'))).toBe(403);
    expect(takedownServiceOffering).not.toHaveBeenCalled();
  });

  it('leaves the report open when the offering no longer exists', async () => {
    takedownServiceOffering.mockResolvedValueOnce(null as never);
    expect(status(await takeDown({ id: '9', reason: 'spam' }))).toBe(410);
    expect(setReportStatus).not.toHaveBeenCalled();
  });
});
