import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { contentIssueSectionFor } = await import('../tickets/content-reports');

const reportsOn = vi.fn();
const removals = vi.fn();
const reads = {
  reportsOn: (...a: unknown[]) => reportsOn(...a),
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
  reportsOn.mockReset().mockResolvedValue([report(1)]);
  removals.mockReset().mockResolvedValue({ rows: [removal(5)], next: null });
});

describe('contentIssueSectionFor', () => {
  it('lists open reports on the user and their image removals', async () => {
    const res = await contentIssueSectionFor({ userId: 7, canRead: all }, reads);
    expect(res).toMatchObject({
      status: 'ok',
      userId: 7,
      reports: { status: 'ok', truncated: false, rows: [{ id: 1, reason: 'TOSViolation' }] },
      removals: { status: 'ok', truncated: false, rows: [{ imageId: 5, reason: 'Adult' }] },
    });
  });

  it('reads each section only under its own page grant', async () => {
    const reportsOnly = await contentIssueSectionFor(
      { userId: 7, canRead: (p) => p === '/reports/user' },
      reads
    );
    expect(reportsOnly).toHaveProperty('reports');
    expect(reportsOnly).not.toHaveProperty('removals');
    expect(removals).not.toHaveBeenCalled();

    reportsOn.mockClear();
    const removalsOnly = await contentIssueSectionFor(
      { userId: 7, canRead: (p) => p === '/retool/user-lookup' },
      reads
    );
    expect(removalsOnly).toHaveProperty('removals');
    expect(removalsOnly).not.toHaveProperty('reports');
    expect(reportsOn).not.toHaveBeenCalled();
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
    reportsOn.mockResolvedValue(Array.from({ length: 11 }, (_, i) => report(i + 1)));
    const res = await contentIssueSectionFor({ userId: 7, canRead: all }, reads);
    expect(reportsOn).toHaveBeenCalledWith(7, 11);
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
