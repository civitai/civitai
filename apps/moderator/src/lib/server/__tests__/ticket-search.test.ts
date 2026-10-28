import { describe, expect, it, vi } from 'vitest';
import type { TicketSearchPage, TicketSummary } from '../freshdesk.service';
import { createLoadCache, readAll, shortReadWarning, type FetchPage } from '../tickets/search';

const TODAY = '2026-10-28';
const day = (i: number) =>
  new Date(Date.UTC(2026, 9, 28) - i * 86_400_000).toISOString().slice(0, 10);

const ticket = (i: number): TicketSummary => ({
  id: String(1000 + i),
  subject: `t${i}`,
  status: 2,
  cfFeature: null,
  tags: [],
  createdAt: `${day(i % 120)}T10:00:00Z`,
  updatedAt: null,
});

/** A fake Freshdesk: 30 per page, 10 pages, `created_at` bounds compared strictly or inclusively. */
function fakeFreshdesk(count: number, inclusive = false) {
  const all = Array.from({ length: count }, (_, i) => ticket(i));
  const calls: string[] = [];
  const fail = new Set<string>();
  const fetchPage: FetchPage = async (expression, page) => {
    calls.push(`${expression}#${page}`);
    if (fail.has(`${expression}#${page}`)) return { status: 'unavailable', reason: 'boom' };
    const after = /created_at:>'([\d-]+)'/.exec(expression)?.[1];
    const before = /created_at:<'([\d-]+)'/.exec(expression)?.[1];
    const hits = all.filter((t) => {
      const d = t.createdAt!.slice(0, 10);
      const gt = after === undefined || (inclusive ? d >= after : d > after);
      const lt = before === undefined || (inclusive ? d <= before : d < before);
      return gt && lt;
    });
    const results = hits.slice((page - 1) * 30, page * 30);
    return { status: 'ok', tickets: results, total: hits.length } satisfies TicketSearchPage;
  };
  return { fetchPage, calls, fail };
}

describe('readAll', () => {
  it('reads a search under the 300 ceiling as plain pages', async () => {
    const { fetchPage, calls } = fakeFreshdesk(100);
    const res = await readAll('status:2', fetchPage, { left: 80 }, TODAY);
    expect(res).toMatchObject({ status: 'ok', total: 100, complete: true });
    expect(res.status === 'ok' && res.tickets).toHaveLength(100);
    expect(calls).toHaveLength(4);
  });

  it.each([false, true])(
    'lists every ticket of a search over the 300 ceiling (inclusive bounds: %s)',
    async (inclusive) => {
      const { fetchPage } = fakeFreshdesk(512, inclusive);
      const res = await readAll('status:2', fetchPage, { left: 80 }, TODAY);
      expect(res.status === 'ok' && res.tickets).toHaveLength(512);
      expect(res).toMatchObject({ complete: true, failedRequests: 0 });
    }
  );

  it('stops at the call budget and says the read is incomplete', async () => {
    const { fetchPage, calls } = fakeFreshdesk(512);
    const res = await readAll('status:2', fetchPage, { left: 10 }, TODAY);
    expect(calls.length).toBeLessThanOrEqual(10);
    expect(res).toMatchObject({ status: 'ok', complete: false });
    expect(res.status === 'ok' && res.tickets.length).toBeGreaterThan(0);
  });

  it('reports a search never asked for (budget spent) as not read, not as zero tickets', async () => {
    const { fetchPage, calls } = fakeFreshdesk(100);
    const res = await readAll('status:2', fetchPage, { left: 0 }, TODAY);
    expect(calls).toHaveLength(0);
    expect(res).toMatchObject({ status: 'ok', tickets: [], total: null, complete: false });
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(shortReadWarning('"Open" tickets', res)).toBe(
      '"Open" tickets were not read (request budget spent); open Freshdesk for these.'
    );
  });

  it('says how many of the total were shown when a read is short', async () => {
    const { fetchPage } = fakeFreshdesk(512);
    const res = await readAll('status:2', fetchPage, { left: 10 }, TODAY);
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(shortReadWarning('"Open" tickets', res)).toMatch(/^Showing \d+ of 512 "Open" tickets/);
  });

  it('fails when the first request fails', async () => {
    const res = await readAll(
      'status:2',
      async () => ({ status: 'unavailable', reason: 'down' }),
      { left: 5 },
      TODAY
    );
    expect(res).toEqual({ status: 'unavailable', reason: 'down' });
  });

  it('keeps what succeeded when a later page fails', async () => {
    const { fetchPage, fail } = fakeFreshdesk(100);
    fail.add('status:2#3');
    const res = await readAll('status:2', fetchPage, { left: 80 }, TODAY);
    expect(res).toMatchObject({ status: 'ok', total: 100, complete: false, failedRequests: 1 });
    expect(res.status === 'ok' && res.tickets).toHaveLength(70);
  });

  it('keeps what succeeded when one window of a split search fails', async () => {
    const { fetchPage, fail, calls } = fakeFreshdesk(512);
    await readAll('status:2', fetchPage, { left: 80 }, TODAY);
    const target = calls.find((c) => c.includes('created_at') && c.endsWith('#1'))!;
    fail.add(target);
    const res = await readAll('status:2', fetchPage, { left: 80 }, TODAY);
    expect(res).toMatchObject({ status: 'ok', complete: false });
    expect(res.status === 'ok' && res.failedRequests).toBeGreaterThan(0);
    expect(res.status === 'ok' && res.tickets.length).toBeGreaterThan(0);
  });
});

describe('createLoadCache', () => {
  it('serves a finished load until it expires', async () => {
    let t = 0;
    const cache = createLoadCache<number>(
      1000,
      () => true,
      () => t
    );
    const load = vi.fn(async () => 1);
    await cache('k', load);
    await cache('k', load);
    expect(load).toHaveBeenCalledTimes(1);
    t = 1001;
    await cache('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not keep a rejected load', async () => {
    const cache = createLoadCache<number>(
      1000,
      () => true,
      () => 0
    );
    await expect(cache('k', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(cache('k', async () => 2)).resolves.toBe(2);
  });

  it('does not keep a load the caller marks unkeepable', async () => {
    const cache = createLoadCache<number>(
      1000,
      (v) => v > 0,
      () => 0
    );
    await cache('k', async () => 0);
    await expect(cache('k', async () => 5)).resolves.toBe(5);
  });
});
