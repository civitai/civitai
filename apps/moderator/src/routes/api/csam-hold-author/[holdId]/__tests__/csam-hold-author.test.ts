import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {} }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({}) }));
const getHoldAuthorHolds = vi.fn();
vi.mock('$lib/server/csam-holds.queries', () => ({ getHoldAuthorHolds }));
const getUserCard = vi.fn();
const getCounts = vi.fn();
const getReportedContent = vi.fn();
vi.mock('$lib/server/user-lookup.service', () => ({ getUserCard, getCounts, getReportedContent }));
const getReportsReceived = vi.fn();
vi.mock('$lib/server/user-reports.service', () => ({ getReportsReceived }));
const canAccess = vi.fn((_user: unknown, _path: string) => true);
vi.mock('$lib/server/access', () => ({ canAccess }));

const { GET } = await import('../+server');
const { DEFAULT_REPORT_REASONS } = await import('$lib/reports');

const call = (holdId: string, grants: Record<string, boolean> = { 'csam.report.file': true }) =>
  GET({ params: { holdId }, locals: { user: { id: 1 }, grants } } as never);

const holds = { userId: 3, total: 1, others: [{ id: 5, status: 'Pending', textHash: 'h-5' }] };

beforeEach(() => {
  vi.clearAllMocks();
  canAccess.mockImplementation(() => true);
  getHoldAuthorHolds.mockResolvedValue(holds);
  getUserCard.mockResolvedValue({ identity: { id: 3 } });
  getCounts.mockResolvedValue([{ label: 'Models', count: 2 }]);
  getReportedContent.mockResolvedValue([{ label: 'Images', count: 0 }]);
  getReportsReceived.mockResolvedValue([{ id: 40, reason: 'TOSViolation' }]);
});

describe('/api/csam-hold-author', () => {
  it('serves the author’s card, content and other holds', async () => {
    expect(await (await call('7')).json()).toEqual({
      userId: 3,
      card: { identity: { id: 3 } },
      counts: [{ label: 'Models', count: 2 }],
      reportedContent: [{ label: 'Images', count: 0 }],
      recentReports: [{ id: 40, reason: 'TOSViolation' }],
      holds: { total: 1, others: holds.others },
    });
    expect(getHoldAuthorHolds).toHaveBeenCalledWith(7);
    expect(getReportsReceived).toHaveBeenCalledTimes(1);
    expect(getReportsReceived).toHaveBeenCalledWith(3, {
      limit: 5,
      reasons: DEFAULT_REPORT_REASONS,
    });
    expect(getUserCard).toHaveBeenCalledWith(3);
  });

  it('gives a moderator who cannot open User Lookup the hold history and nothing of the account', async () => {
    canAccess.mockImplementation((_user, path) => path === '/csam/text-holds');
    expect(await (await call('7')).json()).toEqual({
      userId: 3,
      card: null,
      counts: null,
      reportedContent: null,
      recentReports: null,
      holds: { total: 1, others: holds.others },
    });
    expect(getUserCard).not.toHaveBeenCalled();
    expect(getCounts).not.toHaveBeenCalled();
    expect(getReportedContent).not.toHaveBeenCalled();
    expect(getReportsReceived).not.toHaveBeenCalled();
  });

  it('degrades one failing part without losing the rest', async () => {
    getCounts.mockRejectedValue(new Error('slow'));
    const body = await (await call('7')).json();
    expect(body).toMatchObject({ card: { identity: { id: 3 } }, counts: null });
  });

  it('keeps the card when the recent reports fail to load', async () => {
    getReportsReceived.mockRejectedValue(new Error('slow'));
    const body = await (await call('7')).json();
    expect(body).toMatchObject({ card: { identity: { id: 3 } }, recentReports: null });
  });

  it('refuses a moderator without the csam filing grant before reading anything', async () => {
    await expect(call('7', {})).rejects.toMatchObject({ status: 403 });
    expect(getHoldAuthorHolds).not.toHaveBeenCalled();
  });

  it('refuses a moderator who cannot open the page', async () => {
    canAccess.mockImplementation(() => false);
    await expect(call('7')).rejects.toMatchObject({ status: 403 });
    expect(getHoldAuthorHolds).not.toHaveBeenCalled();
  });

  it('is 404 for a hold without an author, 400 for a bad id', async () => {
    getHoldAuthorHolds.mockResolvedValue(null);
    await expect(call('7')).rejects.toMatchObject({ status: 404 });
    await expect(call('abc')).rejects.toMatchObject({ status: 400 });
  });
});
