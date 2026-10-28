import { describe, expect, it } from 'vitest';
import type { TicketRecord } from './snapshot';
import {
  NONE,
  paginate,
  queryTickets,
  selectTickets,
  ticketListQuerySchema,
  type TicketListQuery,
} from './view-query';

const MOD = 'Moderation Decision';
const BAN = 'Account Restriction or Banned Account';

let seq = 0;
const rec = (over: Partial<TicketRecord> = {}): TicketRecord => {
  seq += 1;
  return {
    id: String(1000 + seq),
    subject: `subject ${seq}`,
    status: 2,
    cfFeature: MOD,
    tags: [],
    createdAt: `2026-10-${String(10 + (seq % 15)).padStart(2, '0')}T00:00:00Z`,
    updatedAt: `2026-10-${String(10 + (seq % 15)).padStart(2, '0')}T12:00:00Z`,
    ...over,
  };
};

const query = (over: Partial<TicketListQuery> = {}): TicketListQuery => ({
  ...ticketListQuerySchema.parse({}),
  ...over,
});
const ctx = (canSeeEmail = false, view: 'moderation' | 'support' = 'moderation') => ({
  view,
  canSeeEmail,
});
const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id);

describe('ticketListQuerySchema', () => {
  it('defaults to updated desc, first page of 50, no filters', () => {
    expect(ticketListQuerySchema.parse({})).toEqual({
      q: '',
      status: [],
      feature: [],
      topic: [],
      sent: undefined,
      sort: 'updated',
      dir: 'desc',
      page: 1,
      limit: 50,
    });
  });

  it('degrades every bad value to its default instead of throwing', () => {
    const parsed = ticketListQuerySchema.parse({
      page: 'abc',
      limit: 'x',
      sort: 'nope',
      dir: 'sideways',
      sent: 'maybe',
      status: 'not-an-array',
      q: ['a', 'b'],
    });
    expect(parsed).toMatchObject({ page: 1, limit: 50, sort: 'updated', dir: 'desc', status: [] });
    expect(parsed.sent).toBeUndefined();
    expect(parsed.q).toBe('');
  });

  it('keeps only live statuses and clamps limit and page', () => {
    const parsed = ticketListQuerySchema.parse({
      status: ['2', '4', 'x', '8'],
      limit: '5000',
      page: '0',
    });
    expect(parsed.status).toEqual([2, 8]);
    expect(parsed.limit).toBe(100);
    expect(parsed.page).toBe(1);
    expect(ticketListQuerySchema.parse({ limit: '0' }).limit).toBe(1);
  });

  it('trims the search text', () => {
    expect(ticketListQuerySchema.parse({ q: '  abc  ' }).q).toBe('abc');
  });
});

describe('routing into the view', () => {
  it('keeps only the tickets that route to the view', () => {
    const mod = rec({ cfFeature: MOD });
    const sup = rec({ cfFeature: 'Billing' });
    expect(ids(queryTickets([mod, sup], query(), ctx(false, 'moderation')))).toEqual([mod.id]);
    expect(ids(queryTickets([mod, sup], query(), ctx(false, 'support')))).toEqual([sup.id]);
  });

  it('uses the router topic of a ticket with no feature', () => {
    const t = rec({ cfFeature: null, routerTopic: 'nsfw-moderation' });
    expect(ids(queryTickets([t], query(), ctx()))).toEqual([t.id]);
  });
});

describe('filters', () => {
  const a = rec({ status: 2, cfFeature: MOD });
  const b = rec({ status: 3, cfFeature: BAN });
  const c = rec({ status: 8, cfFeature: null, routerTopic: null });
  const d = rec({ status: 2, cfFeature: null, routerTopic: 'image-moderation-appeal' });
  const all = [a, b, c, d];

  it('filters by several statuses at once', () => {
    expect(ids(queryTickets(all, query({ status: [2, 3] }), ctx())).sort()).toEqual(
      [a.id, b.id, d.id].sort()
    );
  });

  it('filters by feature, with a bucket for tickets that have none', () => {
    expect(ids(queryTickets(all, query({ feature: [BAN] }), ctx()))).toEqual([b.id]);
    expect(ids(queryTickets(all, query({ feature: [NONE] }), ctx())).sort()).toEqual(
      [c.id, d.id].sort()
    );
    expect(ids(queryTickets(all, query({ feature: [NONE, MOD] }), ctx())).sort()).toEqual(
      [a.id, c.id, d.id].sort()
    );
  });

  it('filters by router topic, with a bucket for tickets with none', () => {
    expect(ids(queryTickets(all, query({ topic: ['image-moderation-appeal'] }), ctx()))).toEqual([
      d.id,
    ]);
    expect(ids(queryTickets(all, query({ topic: [NONE] }), ctx())).sort()).toEqual(
      [a.id, b.id, c.id].sort()
    );
  });

  it('combines filters with AND across kinds and OR within one', () => {
    expect(ids(queryTickets(all, query({ status: [2], feature: [NONE] }), ctx()))).toEqual([d.id]);
  });

  it('keeps or removes tickets sent to support', () => {
    const sent = rec({ status: 8, cfFeature: BAN, tags: ['sent-to-support'] });
    const plain = rec({ status: 8, cfFeature: BAN });
    const both = [sent, plain];
    // status 8 outranks the tag, so both are in the moderation view
    expect(ids(queryTickets(both, query({ sent: 'only' }), ctx()))).toEqual([sent.id]);
    expect(ids(queryTickets(both, query({ sent: 'exclude' }), ctx()))).toEqual([plain.id]);
  });

  it('finds sent-to-support tickets in the support view', () => {
    const sent = rec({ cfFeature: MOD, tags: ['Sent-To-Support'] });
    const other = rec({ cfFeature: 'Billing' });
    expect(
      ids(queryTickets([sent, other], query({ sent: 'only' }), ctx(false, 'support')))
    ).toEqual([sent.id]);
  });

  it('an empty filter list means no filter', () => {
    expect(queryTickets(all, query({ status: [], feature: [], topic: [] }), ctx()).total).toBe(4);
  });
});

describe('sorting', () => {
  const old = rec({ createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' });
  const mid = rec({ createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' });
  const fresh = rec({ createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' });
  const all = [mid, fresh, old];

  it('defaults to most recently updated first', () => {
    expect(ids(queryTickets(all, query(), ctx()))).toEqual([old.id, fresh.id, mid.id]);
  });

  it('sorts by created in either direction', () => {
    expect(ids(queryTickets(all, query({ sort: 'created', dir: 'asc' }), ctx()))).toEqual([
      old.id,
      mid.id,
      fresh.id,
    ]);
    expect(ids(queryTickets(all, query({ sort: 'created', dir: 'desc' }), ctx()))).toEqual([
      fresh.id,
      mid.id,
      old.id,
    ]);
  });

  it('sorts by updated ascending', () => {
    expect(ids(queryTickets(all, query({ dir: 'asc' }), ctx()))).toEqual([
      mid.id,
      fresh.id,
      old.id,
    ]);
  });

  it('puts a ticket with no date last in both directions', () => {
    const undated = rec({ updatedAt: null });
    expect(ids(queryTickets([undated, mid, old], query({ dir: 'desc' }), ctx())).at(-1)).toBe(
      undated.id
    );
    expect(ids(queryTickets([undated, mid, old], query({ dir: 'asc' }), ctx())).at(-1)).toBe(
      undated.id
    );
  });

  it('breaks ties by ticket number so the order is stable across pages', () => {
    const when = '2026-10-01T00:00:00Z';
    const x = rec({ id: '9', updatedAt: when });
    const y = rec({ id: '10', updatedAt: when });
    expect(ids(queryTickets([x, y], query(), ctx()))).toEqual(['10', '9']);
    expect(ids(queryTickets([y, x], query({ dir: 'asc' }), ctx()))).toEqual(['9', '10']);
  });
});

describe('search', () => {
  const t1 = rec({
    id: '74924',
    subject: 'I was Banned unfairly',
    requesterName: 'Ann Lee',
    requesterEmail: 'ann@example.test',
  });
  const t2 = rec({
    id: '74925',
    subject: 'Refund please',
    requesterName: 'Bob Roe',
    requesterEmail: 'bob@example.test',
  });
  const all = [t1, t2];

  it('finds a ticket by id with or without a #', () => {
    expect(ids(queryTickets(all, query({ q: '74924' }), ctx()))).toEqual(['74924']);
    expect(ids(queryTickets(all, query({ q: '#74925' }), ctx()))).toEqual(['74925']);
  });

  it('matches an id exactly, not as a prefix', () => {
    expect(queryTickets(all, query({ q: '7492' }), ctx()).total).toBe(0);
  });

  it('matches the subject case-insensitively as a substring', () => {
    expect(ids(queryTickets(all, query({ q: 'banned UNFAIR' }), ctx()))).toEqual(['74924']);
  });

  it('matches the requester name', () => {
    expect(ids(queryTickets(all, query({ q: 'lee' }), ctx()))).toEqual(['74924']);
  });

  it('matches the email only for a caller with the PII grant', () => {
    expect(queryTickets(all, query({ q: 'bob@example' }), ctx(false)).total).toBe(0);
    expect(ids(queryTickets(all, query({ q: 'bob@example' }), ctx(true)))).toEqual(['74925']);
  });

  it('never puts an email in an item without the PII grant', () => {
    const [item] = queryTickets(all, query({ q: '74924' }), ctx(false)).items;
    expect('requesterEmail' in item).toBe(false);
    expect(JSON.stringify(queryTickets(all, query(), ctx(false)))).not.toContain('example.test');
    const [withGrant] = queryTickets(all, query({ q: '74924' }), ctx(true)).items;
    expect(withGrant.requesterEmail).toBe('ann@example.test');
  });

  it('applies the search together with the filters', () => {
    expect(queryTickets(all, query({ q: 'refund', status: [3] }), ctx()).total).toBe(0);
  });

  it('treats text with regex characters literally', () => {
    expect(queryTickets(all, query({ q: '(' }), ctx()).total).toBe(0);
  });
});

describe('paging', () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    rec({ id: String(5000 + i), updatedAt: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}Z` })
  );

  it('returns the first page with the offset and whether more follow', () => {
    const r = queryTickets(many, query({ limit: 50 }), ctx());
    expect(r).toMatchObject({ total: 120, page: 1, offset: 0, hasMore: true, limit: 50 });
    expect(r.items).toHaveLength(50);
  });

  it('returns a short last page with no more after it', () => {
    const r = queryTickets(many, query({ limit: 50, page: 3 }), ctx());
    expect(r).toMatchObject({ page: 3, offset: 100, hasMore: false });
    expect(r.items).toHaveLength(20);
  });

  it('has no more when the total is an exact multiple', () => {
    const r = queryTickets(many.slice(0, 100), query({ limit: 50, page: 2 }), ctx());
    expect(r).toMatchObject({ page: 2, hasMore: false });
    expect(r.items).toHaveLength(50);
  });

  it('clamps a page past the end to the last page', () => {
    const r = queryTickets(many, query({ limit: 50, page: 99 }), ctx());
    expect(r).toMatchObject({ page: 3, offset: 100 });
    expect(r.items).toHaveLength(20);
  });

  it('reports an empty result as page 1 with nothing after it', () => {
    expect(queryTickets([], query({ page: 4 }), ctx())).toMatchObject({
      items: [],
      total: 0,
      page: 1,
      offset: 0,
      hasMore: false,
    });
  });

  it('does not repeat or skip a ticket across pages', () => {
    const seen = [1, 2, 3].flatMap((page) =>
      ids(queryTickets(many, query({ limit: 50, page }), ctx()))
    );
    expect(new Set(seen).size).toBe(120);
  });

  it('paginates a plain list', () => {
    expect(paginate([1, 2, 3, 4, 5], 2, 2)).toMatchObject({
      items: [3, 4],
      hasMore: true,
      offset: 2,
    });
  });
});

describe('facets', () => {
  const a = rec({ status: 2, cfFeature: MOD, routerTopic: 'x' });
  const b = rec({ status: 2, cfFeature: BAN, routerTopic: null });
  const c = rec({ status: 3, cfFeature: BAN, routerTopic: null });
  const d = rec({ status: 8, cfFeature: null, routerTopic: null });
  const all = [a, b, c, d];

  it('counts each value over the whole view when nothing is filtered', () => {
    const { facets } = queryTickets(all, query(), ctx());
    expect(facets.status).toEqual({ '2': 2, '3': 1, '8': 1 });
    expect(facets.feature).toEqual({ [MOD]: 1, [BAN]: 2, [NONE]: 1 });
    expect(facets.topic).toEqual({ x: 1, [NONE]: 3 });
    expect(facets.sent).toEqual({ only: 0, exclude: 4 });
  });

  it("counts a filter's own values as if it were not applied, so its chips keep their numbers", () => {
    const { facets } = queryTickets(all, query({ status: [2] }), ctx());
    expect(facets.status).toEqual({ '2': 2, '3': 1, '8': 1 });
  });

  it("narrows the other kinds' counts by the active filters", () => {
    const { facets } = queryTickets(all, query({ status: [2] }), ctx());
    expect(facets.feature).toEqual({ [MOD]: 1, [BAN]: 1, [NONE]: 0 });
  });

  it('keeps a value with no match as zero rather than dropping its chip', () => {
    const { facets } = queryTickets(all, query({ feature: [MOD] }), ctx());
    expect(facets.status).toEqual({ '2': 1, '3': 0, '8': 0 });
  });

  it('narrows by the search', () => {
    const only = rec({ id: '77', subject: 'unique words', status: 3, cfFeature: BAN });
    const { facets } = queryTickets([...all, only], query({ q: 'unique' }), ctx());
    expect(facets.status).toEqual({ '2': 0, '3': 1, '8': 0 });
  });

  it('counts only the tickets of the view', () => {
    const elsewhere = rec({ cfFeature: 'Billing', status: 9 });
    const { facets } = queryTickets([...all, elsewhere], query(), ctx());
    expect(facets.status['9']).toBeUndefined();
  });

  it('counts sent-to-support tickets', () => {
    const sent = rec({ status: 8, cfFeature: BAN, tags: ['sent-to-support'] });
    expect(queryTickets([...all, sent], query(), ctx()).facets.sent).toEqual({
      only: 1,
      exclude: 4,
    });
  });
});

describe('selectTickets', () => {
  it('returns every match, unpaged', () => {
    const many = Array.from({ length: 130 }, () => rec());
    expect(selectTickets(many, query(), ctx()).items).toHaveLength(130);
  });
});
