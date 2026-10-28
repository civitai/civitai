import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot, TicketRecord } from '$lib/tickets/snapshot';

const get = vi.fn();
const routed = vi.fn();
const sentBy = vi.fn();

vi.mock('../tickets/snapshot', () => ({ ticketSnapshot: { get: (...a: unknown[]) => get(...a) } }));
vi.mock('../decision-sources/support', () => ({
  getRoutedTicketContext: (...a: unknown[]) => routed(...a),
}));
// `../query` pulls in the database client through this module.
vi.mock('../users.service', () => ({ MAX_INT4: 2_147_483_647 }));
vi.mock('../tickets/sent-by', () => ({ sentByTickets: (...a: unknown[]) => sentBy(...a) }));

const { loadTicketPage, parseTicketQuery } = await import('../tickets/list');

const rec = (id: number, over: Partial<TicketRecord> = {}): TicketRecord => ({
  id: String(id),
  subject: `s${id}`,
  status: 2,
  cfFeature: 'Moderation Decision',
  tags: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: `2026-10-0${id}T00:00:00Z`,
  ...over,
});

const snapshot = (tickets: TicketRecord[]): Snapshot => ({
  tickets,
  syncedAt: 5,
  attemptedAt: 5,
  fullAt: 5,
  needsFull: false,
  readWarnings: [],
  routerFailed: false,
  lastError: null,
});

beforeEach(() => {
  get.mockReset();
  routed.mockReset().mockResolvedValue(new Map());
  sentBy.mockReset().mockResolvedValue(new Map());
});

describe('parseTicketQuery', () => {
  it('reads repeated filter keys and falls back to defaults for junk', () => {
    const q = parseTicketQuery(
      new URL('https://x.test/tickets/moderation?status=2&status=3&feature=A&page=abc&sort=zzz')
    );
    expect(q).toMatchObject({ status: [2, 3], feature: ['A'], page: 1, sort: 'updated' });
  });
});

describe('loadTicketPage', () => {
  it('returns a page with the snapshot warnings and sync time', async () => {
    get.mockResolvedValue({
      status: 'ok',
      snapshot: snapshot([rec(1), rec(2)]),
      warnings: ['careful'],
    });
    const res = await loadTicketPage(
      'moderation',
      parseTicketQuery(new URL('https://x.test/')),
      {}
    );
    expect(res).toMatchObject({
      status: 'ok',
      total: 2,
      warnings: ['careful'],
      syncedAt: 5,
      page: 1,
      hasMore: false,
    });
    expect(res.status === 'ok' && res.items.map((i) => i.id)).toEqual(['2', '1']);
    expect(res.status === 'ok' && res.items[0].freshdeskUrl).toContain('/a/tickets/2');
  });

  it('is unavailable when there is no snapshot, and when anything throws', async () => {
    const q = parseTicketQuery(new URL('https://x.test/'));
    get.mockResolvedValueOnce({ status: 'unavailable', reason: 'nope' });
    expect(await loadTicketPage('moderation', q, {})).toEqual({
      status: 'unavailable',
      reason: 'nope',
    });
    get.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await loadTicketPage('moderation', q, {})).status).toBe('unavailable');
  });

  it('never asks the router for, or returns, a requester address', async () => {
    get.mockResolvedValue({
      status: 'ok',
      snapshot: snapshot([
        rec(1, { requesterName: 'Ann' }),
        { ...rec(2), requesterEmail: 'stale@example.test' } as TicketRecord,
      ]),
      warnings: [],
    });
    const res = await loadTicketPage(
      'moderation',
      parseTicketQuery(new URL('https://x.test/')),
      {}
    );
    expect(routed).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain('example.test');
    expect(res.status === 'ok' && res.items.map((i) => i.requesterName)).toEqual([null, 'Ann']);
  });

  it('does not match a search on an address', async () => {
    get.mockResolvedValue({
      status: 'ok',
      snapshot: snapshot([{ ...rec(1), requesterEmail: 'ann@example.test' } as TicketRecord]),
      warnings: [],
    });
    const res = await loadTicketPage(
      'moderation',
      parseTicketQuery(new URL('https://x.test/?q=ann@example.test')),
      {}
    );
    expect(res.status === 'ok' && res.total).toBe(0);
  });

  it('still lists tickets, with a warning, when the "Sent by" lookup fails', async () => {
    get.mockResolvedValue({
      status: 'ok',
      snapshot: snapshot([rec(1, { tags: ['sent-to-support'] }), rec(2)]),
      warnings: ['careful'],
    });
    sentBy.mockRejectedValue(new Error('moderator db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await loadTicketPage('support', parseTicketQuery(new URL('https://x.test/')), {});
    expect(res.status === 'ok' && res.items.map((i) => [i.id, i.sentBy])).toEqual([['1', null]]);
    expect(res.status === 'ok' && res.warnings).toEqual([
      'careful',
      expect.stringMatching(/who sent/i),
    ]);
  });

  it('names who sent a ticket to support', async () => {
    get.mockResolvedValue({
      status: 'ok',
      snapshot: snapshot([rec(1, { tags: ['sent-to-support'] })]),
      warnings: [],
    });
    sentBy.mockResolvedValue(new Map([['1', { moderatorId: 4, username: 'alice', at: 'x' }]]));
    const res = await loadTicketPage('support', parseTicketQuery(new URL('https://x.test/')), {});
    expect(sentBy).toHaveBeenCalledWith(['1']);
    expect(res.status === 'ok' && res.items[0].sentBy?.username).toBe('alice');
  });
});

describe('loadTicketPage pinned ticket', () => {
  const q = parseTicketQuery(new URL('https://x.test/?status=3'));

  it('returns a ticket of the view that the filters leave off the page', async () => {
    get.mockResolvedValue({
      status: 'ok',
      snapshot: snapshot([rec(1, { status: 3 }), rec(2, { status: 2 })]),
      warnings: [],
    });
    const res = await loadTicketPage('moderation', q, { pinnedId: '2' });
    expect(res.status === 'ok' && res.items.map((i) => i.id)).toEqual(['1']);
    expect(res.status === 'ok' && res.pinned?.id).toBe('2');
    expect(res.status === 'ok' && res.pinned?.freshdeskUrl).toContain('/a/tickets/2');
  });

  it('decorates the pinned ticket like a listed one', async () => {
    get.mockResolvedValue({
      status: 'ok',
      snapshot: snapshot([
        rec(1, { status: 3, tags: ['sent-to-support'] }),
        rec(2, { status: 2, tags: ['sent-to-support'] }),
      ]),
      warnings: [],
    });
    sentBy.mockResolvedValue(
      new Map([
        ['1', { moderatorId: 4, username: 'alice', at: 'x' }],
        ['2', { moderatorId: 5, username: 'bob', at: 'y' }],
      ])
    );
    const res = await loadTicketPage('support', q, { pinnedId: '2' });
    expect(res.status === 'ok' && res.items.map((i) => [i.id, i.sentBy?.username])).toEqual([
      ['1', 'alice'],
    ]);
    expect(res.status === 'ok' && [res.pinned?.id, res.pinned?.sentBy?.username]).toEqual([
      '2',
      'bob',
    ]);
    expect(sentBy).toHaveBeenCalledTimes(1);
  });

  it('pins nothing when the ticket is already on the page, is unknown, or belongs to the other view', async () => {
    get.mockResolvedValue({
      status: 'ok',
      snapshot: snapshot([rec(1, { status: 3 }), rec(2, { status: 2, cfFeature: 'Billing' })]),
      warnings: [],
    });
    for (const pinnedId of ['1', '99', '2']) {
      const res = await loadTicketPage('moderation', q, { pinnedId });
      expect(res.status === 'ok' && res.pinned).toBeNull();
      expect(res.status === 'ok' && res.items.map((i) => i.id)).toEqual(['1']);
    }
  });
});
