import { describe, expect, it, vi } from 'vitest';
import type { ChangedPage, TicketSearchPage, TicketSummary } from '../freshdesk.service';
import {
  DELTA_MAX_PAGES,
  FULL_CALL_BUDGET,
  readChanged,
  readLive,
} from '../tickets/snapshot-reads';
import { LIVE_STATUSES } from '$lib/tickets/statuses';

const summary = (id: number, status = 2): TicketSummary => ({
  id: String(id),
  subject: `s${id}`,
  status,
  cfFeature: null,
  tags: [],
  createdAt: null,
  updatedAt: null,
});
const changed = (id: number, status = 2) => ({
  ...summary(id, status),
  requesterName: null,
  requesterEmail: null,
  gone: false,
});

describe('readChanged', () => {
  it('reads one page when it is not full', async () => {
    const fetchPage = vi.fn(
      async (): Promise<ChangedPage> => ({ status: 'ok', tickets: [changed(1)], hasMore: false })
    );
    const res = await readChanged(fetchPage, '2026-10-28T00:00:00.000Z');
    expect(res).toMatchObject({ status: 'ok', complete: true });
    expect(res.status === 'ok' && res.changed.map((t) => t.id)).toEqual(['1']);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith('2026-10-28T00:00:00.000Z', 1);
  });

  it('follows full pages in order', async () => {
    const fetchPage = vi.fn(
      async (_since: string, page: number): Promise<ChangedPage> => ({
        status: 'ok',
        tickets: [changed(page)],
        hasMore: page < 3,
      })
    );
    const res = await readChanged(fetchPage, 's');
    expect(res.status === 'ok' && res.changed.map((t) => t.id)).toEqual(['1', '2', '3']);
    expect(res).toMatchObject({ complete: true });
  });

  it('stops at the page cap and says the read is incomplete', async () => {
    const fetchPage = vi.fn(
      async (_s: string, page: number): Promise<ChangedPage> => ({
        status: 'ok',
        tickets: [changed(page)],
        hasMore: true,
      })
    );
    const res = await readChanged(fetchPage, 's');
    expect(fetchPage).toHaveBeenCalledTimes(DELTA_MAX_PAGES);
    expect(res).toMatchObject({ status: 'ok', complete: false });
  });

  it('fails the whole read when any page fails, so no half-delta is applied', async () => {
    const fetchPage = vi.fn(
      async (_s: string, page: number): Promise<ChangedPage> =>
        page === 2
          ? { status: 'unavailable', reason: 'Freshdesk returned 500.' }
          : { status: 'ok', tickets: [changed(page)], hasMore: true }
    );
    expect(await readChanged(fetchPage, 's')).toEqual({
      status: 'unavailable',
      reason: 'Freshdesk returned 500.',
    });
  });
});

describe('readLive', () => {
  const page = (tickets: TicketSummary[], total = tickets.length): TicketSearchPage => ({
    status: 'ok',
    tickets,
    total,
  });

  it('searches every live status and joins the tickets', async () => {
    const asked: string[] = [];
    const fetchPage = vi.fn(async (expression: string) => {
      asked.push(expression);
      const status = Number(/status:(\d+)/.exec(expression)![1]);
      return page([summary(status, status)]);
    });
    const res = await readLive(fetchPage, '2026-10-28');
    expect(asked.sort()).toEqual(LIVE_STATUSES.map((s) => `status:${s}`).sort());
    expect(res).toMatchObject({ status: 'ok', complete: true, warnings: [] });
    expect(res.status === 'ok' && res.tickets).toHaveLength(LIVE_STATUSES.length);
  });

  it('fails when a status search fails at its first request', async () => {
    const fetchPage = vi.fn(
      async (): Promise<TicketSearchPage> => ({
        status: 'unavailable',
        reason: 'Freshdesk returned 429.',
      })
    );
    expect(await readLive(fetchPage, '2026-10-28')).toEqual({
      status: 'unavailable',
      reason: 'Freshdesk returned 429.',
    });
  });

  it('keeps what it read and warns when the call budget runs out', async () => {
    const calls = { n: 0 };
    const fetchPage = vi.fn(async () => {
      calls.n += 1;
      // 12,000 matches everywhere: each status needs splitting by day, which the budget cannot cover.
      return page([summary(calls.n)], 12_000);
    });
    const res = await readLive(fetchPage, '2026-10-28');
    expect(calls.n).toBeLessThanOrEqual(FULL_CALL_BUDGET);
    expect(res).toMatchObject({ status: 'ok', complete: false });
    expect(res.status === 'ok' && res.warnings.length).toBeGreaterThan(0);
  });

  it('warns about a failed page without failing the read', async () => {
    const fetchPage = vi.fn(async (_expression: string, p: number) => {
      if (p === 2) return { status: 'unavailable', reason: 'x' } as const;
      return page([summary(p)], 60);
    });
    const res = await readLive(fetchPage, '2026-10-28');
    expect(res).toMatchObject({ status: 'ok', complete: false });
    expect(res.status === 'ok' && res.warnings.join(' ')).toMatch(/failed/);
  });
});
