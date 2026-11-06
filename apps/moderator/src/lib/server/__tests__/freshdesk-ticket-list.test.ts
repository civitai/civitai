import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANGED_PAGE_SIZE, listTicketsUpdatedSince } from '../freshdesk.service';

/** The changed-since list, against a stubbed `fetch`. No Freshdesk call is made. */

const saved = { key: process.env.FRESHDESK_API_KEY, domain: process.env.FRESHDESK_DOMAIN };
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

beforeEach(() => {
  process.env.FRESHDESK_API_KEY = 'test-key';
  process.env.FRESHDESK_DOMAIN = 'help.example.test';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [k, v] of [
    ['FRESHDESK_API_KEY', saved.key],
    ['FRESHDESK_DOMAIN', saved.domain],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

describe('listTicketsUpdatedSince', () => {
  it('asks for one newest-first page of tickets changed since the time, with their requester', async () => {
    fetchMock.mockResolvedValueOnce(json([]));
    await listTicketsUpdatedSince('2026-10-28T10:00:00.000Z', 2);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v2/tickets');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      updated_since: '2026-10-28T10:00:00.000Z',
      per_page: String(CHANGED_PAGE_SIZE),
      page: '2',
      order_by: 'updated_at',
      order_type: 'desc',
      include: 'requester',
    });
  });

  it('maps tickets of every status, with tags, feature and requester', async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        {
          id: 11,
          subject: 'Banned',
          status: 2,
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-28T10:01:00Z',
          tags: ['a'],
          custom_fields: { cf_feature: ' Moderation Decision ' },
          requester: { name: 'Ann', email: 'ann@example.test' },
        },
        { id: 12, subject: 'Done', status: 4, tags: [], custom_fields: {} },
      ])
    );
    const res = await listTicketsUpdatedSince('2026-10-28T10:00:00.000Z', 1);
    expect(res).toMatchObject({ status: 'ok', hasMore: false });
    if (res.status !== 'ok') throw new Error('unreachable');
    expect(res.tickets[0]).toMatchObject({
      id: '11',
      status: 2,
      tags: ['a'],
      cfFeature: 'Moderation Decision',
      requesterName: 'Ann',
      requesterEmail: 'ann@example.test',
      gone: false,
    });
    expect(res.tickets[1]).toMatchObject({ id: '12', status: 4, requesterName: null });
  });

  it('flags a deleted or spam ticket', async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        { id: 1, status: 2, deleted: true },
        { id: 2, status: 2, spam: true },
        { id: 3, status: 2, deleted: false, spam: false },
      ])
    );
    const res = await listTicketsUpdatedSince('2026-10-28T10:00:00.000Z', 1);
    expect(res.status === 'ok' && res.tickets.map((t) => t.gone)).toEqual([true, true, false]);
  });

  it('says another page follows only when this one is full', async () => {
    const full = Array.from({ length: CHANGED_PAGE_SIZE }, (_, i) => ({ id: i + 1, status: 2 }));
    fetchMock.mockResolvedValueOnce(json(full));
    const res = await listTicketsUpdatedSince('2026-10-28T10:00:00.000Z', 1);
    expect(res).toMatchObject({ status: 'ok', hasMore: true });
  });

  it('reports a failed or unexpected response rather than an empty list', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 500 }));
    expect((await listTicketsUpdatedSince('2026-10-28T10:00:00.000Z', 1)).status).toBe(
      'unavailable'
    );
    fetchMock.mockResolvedValueOnce(json({ not: 'a list' }));
    expect((await listTicketsUpdatedSince('2026-10-28T10:00:00.000Z', 1)).status).toBe(
      'unavailable'
    );
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'retry-after': '30' } })
    );
    const limited = await listTicketsUpdatedSince('2026-10-28T10:00:00.000Z', 1);
    expect(limited).toMatchObject({ status: 'unavailable' });
    expect(limited.status === 'unavailable' && limited.reason).toContain('30s');
  });

  it('reports a missing key without calling Freshdesk', async () => {
    delete process.env.FRESHDESK_API_KEY;
    const res = await listTicketsUpdatedSince('2026-10-28T10:00:00.000Z', 1);
    expect(res.status).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
