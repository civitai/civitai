import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
const getReportsReceived = vi.fn();
const getReportsOnUser = vi.fn();
vi.mock('../user-reports.service', () => ({
  getReportsReceived: (...a: unknown[]) => getReportsReceived(...a),
  getReportsOnUser: (...a: unknown[]) => getReportsOnUser(...a),
}));

const { contentIssueSectionFor } = await import('../tickets/content-reports');
const { toVisibleRemovals } = await import('../tickets/history');

const reportsReceived = vi.fn();
const removals = vi.fn();
const reads = {
  reportsReceived: (...a: unknown[]) => reportsReceived(...a),
  removals: (...a: unknown[]) => removals(...a),
} as never;
const all = () => true;

const report = (id: number) => ({
  id,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  reason: 'TOSViolation',
  status: 'Pending',
  reporter: 'someone',
});
const removal = (imageId: number, over: Record<string, unknown> = {}) => ({
  key: `k${imageId}`,
  type: 'DeleteTOS',
  at: '2026-10-01T00:00:00.000Z',
  imageId,
  actorUsername: 'mod',
  tosReason: 'Adult',
  violationType: null,
  ...over,
});

beforeEach(() => {
  reportsReceived.mockReset().mockResolvedValue([report(1)]);
  removals.mockReset().mockResolvedValue({ rows: [removal(5)], next: null });
});

describe('contentIssueSectionFor', () => {
  it("lists open reports on the user' content and their image removals", async () => {
    const res = await contentIssueSectionFor({ userId: 7, canRead: all }, reads);
    expect(res).toMatchObject({
      status: 'ok',
      userId: 7,
      reports: { status: 'ok', truncated: false, rows: [{ id: 1, reason: 'TOSViolation' }] },
      removals: { status: 'ok', truncated: false, rows: [{ imageId: 5, reason: 'Adult' }] },
    });
  });

  it('reads each section only under its own page grant', async () => {
    const reportsReceivedly = await contentIssueSectionFor(
      { userId: 7, canRead: (p) => p === '/reports/user' },
      reads
    );
    expect(reportsReceivedly).toHaveProperty('reports');
    expect(reportsReceivedly).not.toHaveProperty('removals');
    expect(removals).not.toHaveBeenCalled();

    reportsReceived.mockClear();
    const removalsOnly = await contentIssueSectionFor(
      { userId: 7, canRead: (p) => p === '/retool/user-lookup' },
      reads
    );
    expect(removalsOnly).toHaveProperty('removals');
    expect(removalsOnly).not.toHaveProperty('reports');
    expect(reportsReceived).not.toHaveBeenCalled();
  });

  it('turns a ClickHouse failure into an unavailable removals section, leaving reports', async () => {
    removals.mockRejectedValue(new Error('clickhouse down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await contentIssueSectionFor({ userId: 7, canRead: all }, reads);
    expect(res).toMatchObject({
      status: 'ok',
      reports: { status: 'ok' },
      removals: { status: 'unavailable' },
    });
  });

  it('asks for one row over the cap and says when the list was cut', async () => {
    reportsReceived.mockResolvedValue(Array.from({ length: 11 }, (_, i) => report(i + 1)));
    const res = await contentIssueSectionFor({ userId: 7, canRead: all }, reads);
    expect(reportsReceived).toHaveBeenCalledWith(7, 11);
    expect(res).toMatchObject({ reports: { truncated: true } });
    if (res.reports?.status === 'ok') expect(res.reports.rows).toHaveLength(10);
  });

  it('never shows a CSAM removal, however it was labelled', async () => {
    removals.mockResolvedValue({
      rows: [
        removal(1, { tosReason: 'CSAM' }),
        removal(2, { violationType: 'csam-suspected' }),
        removal(3),
      ],
      next: null,
    });
    const res = await contentIssueSectionFor({ userId: 7, canRead: all }, reads);
    if (res.removals?.status !== 'ok') throw new Error('expected ok');
    expect(res.removals.rows.map((r) => r.imageId)).toEqual([3]);
  });
});

describe('removal shaping', () => {
  it("is the history card's helper: the content card shows exactly what it keeps", async () => {
    const rows = [
      removal(1, { tosReason: 'CSAM' }),
      removal(2),
      removal(3, { violationType: 'Csam' }),
    ];
    removals.mockResolvedValue({ rows, next: null });
    const res = await contentIssueSectionFor({ userId: 7, canRead: all }, reads);
    if (res.removals?.status !== 'ok') throw new Error('expected ok');
    expect(res.removals.rows).toEqual(toVisibleRemovals(rows as never));
    expect(res.removals.rows.map((r) => r.imageId)).toEqual([2]);
  });
});

describe('the live reports read', () => {
  it("reads reports filed against the user's content, open and human, one row over the cap", async () => {
    getReportsReceived.mockResolvedValue([report(4)]);
    const res = await contentIssueSectionFor({
      userId: 7,
      canRead: (p) => p === '/reports/user',
    });
    expect(getReportsReceived).toHaveBeenCalledWith(7, {
      limit: 11,
      statuses: ['Pending', 'Processing'],
      reasons: expect.not.arrayContaining(['Automated']),
    });
    expect(getReportsOnUser).not.toHaveBeenCalled();
    expect(res).toMatchObject({ reports: { status: 'ok', rows: [{ id: 4 }] } });
  });
});
