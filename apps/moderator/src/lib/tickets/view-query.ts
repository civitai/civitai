import { z } from 'zod';
import { hasSentToSupportTag, routeTicket, type TicketView } from './routing';
import type { TicketRecord } from './snapshot';
import { isLiveStatus } from './snapshot';
import { statusLabel } from './statuses';

/** The filter value for a ticket that has no feature, or no router topic. */
export const NONE = '__none';

export const TICKET_PAGE_SIZE = 50;
export const TICKET_PAGE_MAX = 100;

/** Keys that repeat in the URL; the third argument of `parseQuery`. */
export const TICKET_QUERY_MULTI_KEYS = ['status', 'feature', 'topic'];

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

const strings = z.array(z.string()).catch([]);

/** Every field falls back to its default, so a hand-edited URL never throws. Extend it for page-specific keys. */
export const ticketListQuerySchema = z.object({
  q: z.string().trim().max(200).catch(''),
  status: strings.transform((v) =>
    v.map(Number).filter((n) => Number.isInteger(n) && isLiveStatus(n))
  ),
  feature: strings,
  topic: strings,
  sent: z.enum(['only', 'exclude']).optional().catch(undefined),
  sort: z.enum(['updated', 'created']).catch('updated'),
  dir: z.enum(['asc', 'desc']).catch('desc'),
  page: z.coerce
    .number()
    .int()
    .catch(1)
    .transform((n) => Math.max(1, n)),
  limit: z.coerce
    .number()
    .int()
    .catch(TICKET_PAGE_SIZE)
    .transform((n) => clamp(n, 1, TICKET_PAGE_MAX)),
});

export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

/** One row of a view. The address is present only when the caller holds the PII grant. */
export type TicketItem = {
  id: string;
  subject: string;
  status: number;
  statusLabel: string;
  cfFeature: string | null;
  routerTopic: string | null;
  civitaiUserId: number | null;
  requesterName: string | null;
  requesterEmail?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  sentToSupport: boolean;
};

/** Ticket count per filter value; keys are status ids, feature names and topics, with `NONE` for neither. */
export type TicketFacets = {
  status: Record<string, number>;
  feature: Record<string, number>;
  topic: Record<string, number>;
  sent: { only: number; exclude: number };
};

export type QueryContext = { view: TicketView; canSeeEmail: boolean };

type Predicates = {
  status: (t: TicketRecord) => boolean;
  feature: (t: TicketRecord) => boolean;
  topic: (t: TicketRecord) => boolean;
  sent: (t: TicketRecord) => boolean;
  q: (t: TicketRecord) => boolean;
};

const featureKey = (t: TicketRecord) => t.cfFeature ?? NONE;
const topicKey = (t: TicketRecord) => t.routerTopic ?? NONE;

const oneOf = (selected: readonly string[], key: (t: TicketRecord) => string) =>
  selected.length === 0 ? () => true : (t: TicketRecord) => selected.includes(key(t));

function predicates(query: TicketListQuery, canSeeEmail: boolean): Predicates {
  const needle = query.q.toLowerCase();
  const id = query.q.replace(/^#/, '');
  const has = (value: string | null | undefined) => !!value && value.toLowerCase().includes(needle);
  return {
    status: oneOf(query.status.map(String), (t) => String(t.status)),
    feature: oneOf(query.feature, featureKey),
    topic: oneOf(query.topic, topicKey),
    sent: (t) =>
      query.sent === undefined || hasSentToSupportTag(t.tags) === (query.sent === 'only'),
    q: (t) =>
      needle === '' ||
      t.id === id ||
      has(t.subject) ||
      has(t.requesterName) ||
      (canSeeEmail && has(t.requesterEmail)),
  };
}

const count = (tickets: readonly TicketRecord[], keep: (t: TicketRecord) => boolean) =>
  tickets.reduce((n, t) => n + (keep(t) ? 1 : 0), 0);

/** Every value the view holds, counted over the tickets that pass every OTHER filter. */
function facetsOf(inView: readonly TicketRecord[], p: Predicates): TicketFacets {
  const others = (skip: keyof Predicates) => (t: TicketRecord) =>
    (Object.keys(p) as (keyof Predicates)[]).every((k) => k === skip || p[k](t));
  const tally = (skip: keyof Predicates, key: (t: TicketRecord) => string) => {
    const keep = others(skip);
    const out: Record<string, number> = {};
    for (const t of inView) out[key(t)] = (out[key(t)] ?? 0) + (keep(t) ? 1 : 0);
    return out;
  };
  const sentKeep = others('sent');
  return {
    status: tally('status', (t) => String(t.status)),
    feature: tally('feature', featureKey),
    topic: tally('topic', topicKey),
    sent: {
      only: count(inView, (t) => sentKeep(t) && hasSentToSupportTag(t.tags)),
      exclude: count(inView, (t) => sentKeep(t) && !hasSentToSupportTag(t.tags)),
    },
  };
}

/** Compares ticket numbers as numbers without losing precision on a long id. */
const byId = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

function compare(query: TicketListQuery) {
  const field = query.sort === 'created' ? 'createdAt' : 'updatedAt';
  const sign = query.dir === 'asc' ? 1 : -1;
  return (a: TicketRecord, b: TicketRecord) => {
    const x = a[field];
    const y = b[field];
    if (!x !== !y) return x ? -1 : 1;
    if (x && y && x !== y) return x < y ? -sign : sign;
    return sign * byId(a.id, b.id);
  };
}

function toItem(t: TicketRecord, canSeeEmail: boolean): TicketItem {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    statusLabel: statusLabel(t.status),
    cfFeature: t.cfFeature,
    routerTopic: t.routerTopic ?? null,
    civitaiUserId: t.civitaiUserId ?? null,
    requesterName: t.requesterName ?? null,
    ...(canSeeEmail ? { requesterEmail: t.requesterEmail ?? null } : {}),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    sentToSupport: hasSentToSupportTag(t.tags),
  };
}

/** Every ticket of the view that passes the filters and the search, sorted, with the facet counts. Unpaged. */
export function selectTickets(
  records: readonly TicketRecord[],
  query: TicketListQuery,
  { view, canSeeEmail }: QueryContext
): { items: TicketItem[]; facets: TicketFacets } {
  const inView = records.filter(
    (t) =>
      routeTicket({
        cfFeature: t.cfFeature,
        status: t.status,
        routerTopic: t.routerTopic,
        tags: t.tags,
      }) === view
  );
  const p = predicates(query, canSeeEmail);
  const matching = inView.filter((t) => Object.values(p).every((keep) => keep(t)));
  return {
    items: matching.sort(compare(query)).map((t) => toItem(t, canSeeEmail)),
    facets: facetsOf(inView, p),
  };
}

/** One ticket of the view as a row, or null when the snapshot lacks it or it routes to the other view. */
export function findTicket(
  records: readonly TicketRecord[],
  id: string,
  { view, canSeeEmail }: QueryContext
): TicketItem | null {
  const t = records.find((r) => r.id === id);
  if (!t) return null;
  const routesTo = routeTicket({
    cfFeature: t.cfFeature,
    status: t.status,
    routerTopic: t.routerTopic,
    tags: t.tags,
  });
  return routesTo === view ? toItem(t, canSeeEmail) : null;
}

export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  offset: number;
  hasMore: boolean;
  limit: number;
};

/** One page of `all`. A page past the end is the last page, so a stale link shows tickets, not an empty list. */
export function paginate<T>(all: readonly T[], page: number, limit: number): Page<T> {
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const at = Math.min(Math.max(1, page), pages);
  const offset = (at - 1) * limit;
  return {
    items: all.slice(offset, offset + limit),
    total,
    page: at,
    offset,
    hasMore: offset + limit < total,
    limit,
  };
}

export type TicketPage = Page<TicketItem> & { facets: TicketFacets };

/** A page of a view for a parsed URL: what a list page's load returns. */
export function queryTickets(
  records: readonly TicketRecord[],
  query: TicketListQuery,
  context: QueryContext
): TicketPage {
  const { items, facets } = selectTickets(records, query, context);
  return { ...paginate(items, query.page, query.limit), facets };
}
