import { env } from '$env/dynamic/private';
import { convertHtml } from './html-to-text';

// Support context for User Lookup (Retool's GetFreshdesk, ticket §1.2 "support context").
//
// Retool called civitai.freshdesk.com/api/v2/search/contacts directly with a hardcoded key. Here the key
// is FRESHDESK_API_KEY and the domain FRESHDESK_DOMAIN, matching the names the main app already uses.
//
// Never throws — a support lookup must not blank an investigation panel, and the key is optional in
// development. But it distinguishes "this user has no contact" from "we could not ask": collapsing an
// unset key, a 429 or a timeout into the same answer as a genuine miss lets a moderator working a ban
// appeal conclude the user never contacted support.

export type FreshdeskContact = {
  id: number;
  name: string | null;
  email: string | null;
  createdAt: string | null;
  url: string;
};

export type FreshdeskResult =
  | { status: 'found'; contact: FreshdeskContact }
  | { status: 'none' }
  | Unavailable;

const DEFAULT_FRESHDESK_DOMAIN = 'civitai.freshdesk.com';

/** The bare Freshdesk host. Tolerates a configured value that carries a scheme or a trailing slash,
 *  which would otherwise produce `https://https://…`. */
export const freshdeskHost = (configured: string | undefined = env.FRESHDESK_DOMAIN): string =>
  (configured || DEFAULT_FRESHDESK_DOMAIN).replace(/^https?:\/\//, '').replace(/\/+$/, '');

/**
 * The agent-side URL of one ticket. 🔴 THE ONE PLACE A TICKET LINK IS BUILT — every ticket link on
 * `/decisions` goes through it, including tickets whose source row carries a URL of its own (seeded
 * groups have none, so a stored URL cannot be the rule).
 */
export const freshdeskTicketUrl = (
  ticketId: string | number,
  domain: string | undefined = env.FRESHDESK_DOMAIN
): string => `https://${freshdeskHost(domain)}/a/tickets/${encodeURIComponent(String(ticketId))}`;

/** Freshdesk's numeric id format — tickets and conversations alike. */
export const isFreshdeskId = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{1,20}$/.test(v);

export type Unavailable = { status: 'unavailable'; reason: string };
const unavailable = (reason: string): Unavailable => ({ status: 'unavailable', reason });
const NOT_CONFIGURED = unavailable('Freshdesk is not configured.');

/**
 * One authenticated, READ-ONLY GET against the v2 API: the parsed body, or why it could not be had.
 * Every Freshdesk call here goes through it, so "could not ask" is reported one way.
 *
 * ⚠️ Freshdesk rate-limits per ACCOUNT, not per key, so every call draws on the same hourly pool as
 * every other integration using the account — a 429 says so rather than reading as an outage.
 */
async function freshdeskGet(
  path: string,
  label: string,
  /** The reason to report for a 404, where a 404 means something specific to the caller. */
  notFound: string | null = null,
  timeoutMs = 8000
): Promise<{ status: 'ok'; body: unknown } | Unavailable> {
  const key = env.FRESHDESK_API_KEY;
  if (!key) return NOT_CONFIGURED;
  // Freshdesk authenticates with the API key as the basic-auth username and any password.
  const auth = Buffer.from(`${key}:X`).toString('base64');
  try {
    const res = await fetch(`https://${freshdeskHost()}/api/v2${path}`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404 && notFound !== null) return unavailable(notFound);
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after'));
      return unavailable(
        `Freshdesk's rate limit is reached${
          Number.isFinite(wait) && wait > 0 ? ` — try again in ${wait}s` : ''
        }.`
      );
    }
    if (!res.ok) {
      console.error(`[freshdesk] ${label} failed`, res.status);
      return unavailable(`Freshdesk returned ${res.status}.`);
    }
    return { status: 'ok', body: (await res.json()) as unknown };
  } catch (e) {
    console.error(`[freshdesk] ${label} error`, e);
    return unavailable('Freshdesk did not respond.');
  }
}

/** One public reply an agent sent on a ticket. */
export type AgentReply = { conversationId: string; createdAt: string | null; text: string };

export type AgentRepliesResult =
  /** `truncated`: the page cap was reached, so a later reply may be missing from `replies`. */
  { status: 'found'; replies: AgentReply[]; truncated: boolean } | { status: 'none' } | Unavailable;

/** Conversations per page — Freshdesk's maximum. */
export const CONVERSATIONS_PER_PAGE = 100;
/** Pages read before stopping. A ticket past this many conversations offers only its earliest, and
 *  says so (`truncated`). */
export const CONVERSATION_PAGE_CAP = 5;

type RawConversation = {
  id?: number | string;
  incoming?: boolean;
  private?: boolean;
  body?: string | null;
  body_text?: string | null;
  created_at?: string | null;
};

type ConversationsRead = { status: 'ok'; all: RawConversation[]; truncated: boolean } | Unavailable;

/** Every conversation on a ticket up to the page cap. READ-ONLY; `truncated` when the cap stopped it. */
async function readConversations(ticketId: string): Promise<ConversationsRead> {
  const all: RawConversation[] = [];
  let truncated = false;
  for (let page = 1; page <= CONVERSATION_PAGE_CAP; page++) {
    const res = await freshdeskGet(
      `/tickets/${ticketId}/conversations?per_page=${CONVERSATIONS_PER_PAGE}&page=${page}`,
      'conversations',
      `Freshdesk has no ticket ${ticketId} — it may have been deleted or merged.`
    );
    if (res.status !== 'ok') return res;
    if (!Array.isArray(res.body)) {
      console.error('[freshdesk] conversations: unexpected body');
      return unavailable('Freshdesk returned an unexpected response.');
    }
    all.push(...(res.body as RawConversation[]));
    if (res.body.length < CONVERSATIONS_PER_PAGE) break;
    truncated = page === CONVERSATION_PAGE_CAP;
  }
  return { status: 'ok', all, truncated };
}

/**
 * The public replies an AGENT sent on one ticket, newest first — what `/decisions` offers to pre-fill
 * a canonical answer from. READ-ONLY: this module never writes to Freshdesk.
 *
 * 🔴 `incoming === false && private === false`, BOTH STRICTLY. `incoming` true is the customer's own
 * message and `private` true is an internal note; a missing field is neither proven false, so it is
 * dropped — offering a customer's message or a note as "the agent's answer" is the failure to avoid.
 *
 * 🔴 `unavailable` IS NOT `none`. An unset key, a 404 (deleted or merged ticket), a 429 or a timeout
 * mean "could not ask"; reporting any of them as "no reply" tells the moderator the ticket was never
 * answered. Never throws. Runs on a moderator's click only.
 */
export async function getPublicAgentReplies(ticketId: string): Promise<AgentRepliesResult> {
  if (!env.FRESHDESK_API_KEY) return NOT_CONFIGURED;
  if (!isFreshdeskId(ticketId)) return unavailable('Not a Freshdesk ticket id.');

  const read = await readConversations(ticketId);
  if (read.status !== 'ok') return read;
  const { all, truncated } = read;

  const replies = all
    .filter((c) => c.incoming === false && c.private === false)
    .map((c) => ({
      conversationId: c.id == null ? '' : String(c.id),
      createdAt: c.created_at ?? null,
      text: (c.body_text ?? '').trim(),
    }))
    .filter((r) => isFreshdeskId(r.conversationId) && r.text !== '')
    // ISO-8601 timestamps sort as strings; a reply with none sorts last.
    .sort((x, y) => (y.createdAt ?? '').localeCompare(x.createdAt ?? ''));
  if (replies.length > 0) return { status: 'found', replies, truncated };
  // Nothing in what was read is not "no reply" when there was more to read.
  return truncated
    ? unavailable(
        `Only the first ${
          CONVERSATION_PAGE_CAP * CONVERSATIONS_PER_PAGE
        } conversations were read, and none of them is a public agent reply.`
      )
    : { status: 'none' };
}

export async function getFreshdeskContact(email: string | null): Promise<FreshdeskResult> {
  if (!env.FRESHDESK_API_KEY) return NOT_CONFIGURED;
  if (!email) return unavailable('This account has no email address.');

  const query = encodeURIComponent(`"email:'${email.replace(/'/g, '')}'"`);
  const res = await freshdeskGet(`/search/contacts?query=${query}`, 'search');
  if (res.status !== 'ok') return res;
  if (typeof res.body !== 'object' || res.body === null || Array.isArray(res.body)) {
    console.error('[freshdesk] search: unexpected body');
    return unavailable('Freshdesk returned an unexpected response.');
  }
  const body = res.body as {
    results?: { id: number; name?: string; email?: string; created_at?: string }[];
  };
  const hit = body.results?.[0];
  if (!hit) return { status: 'none' };
  return {
    status: 'found',
    contact: {
      id: hit.id,
      name: hit.name ?? null,
      email: hit.email ?? null,
      createdAt: hit.created_at ?? null,
      url: `https://${freshdeskHost()}/a/contacts/${hit.id}`,
    },
  };
}

export type TicketDescriptionResult =
  | { status: 'found'; text: string; truncated: boolean }
  | { status: 'none' }
  | Unavailable;

/** Characters of description shown. The rest is one click away in Freshdesk. */
export const DESCRIPTION_MAX_CHARS = 20_000;
/** Shorter than the default: a page is waiting on it, and the stored excerpt is a fine fallback. */
export const DESCRIPTION_TIMEOUT_MS = 4000;

/** A ticket description as text, with the "empty because unread is not empty" distinction kept. */
function describeHtml(html: string): TicketDescriptionResult {
  const { text, complete } = convertHtml(html);
  // 🔴 Empty because the converter stopped reading is NOT "no description" — say why instead.
  if (!text)
    return complete
      ? { status: 'none' }
      : unavailable("Freshdesk's formatted copy could not be read in full; open it in Freshdesk.");
  return text.length > DESCRIPTION_MAX_CHARS
    ? { status: 'found', text: text.slice(0, DESCRIPTION_MAX_CHARS), truncated: true }
    : { status: 'found', text, truncated: !complete };
}

/**
 * A ticket's first message as Freshdesk formats it — its HTML `description`, converted to text here
 * because the router's stored excerpt comes from `description_text`, which Freshdesk flattens to one
 * line for many HTML emails. READ-ONLY, and never throws.
 *
 * 🔴 `text` IS PLAIN TEXT (see `htmlToText`), and it is customer-written: render it as text only.
 */
export async function getTicketDescription(ticketId: string): Promise<TicketDescriptionResult> {
  if (!env.FRESHDESK_API_KEY) return NOT_CONFIGURED;
  if (!isFreshdeskId(ticketId)) return unavailable('Not a Freshdesk ticket id.');

  const res = await freshdeskGet(
    `/tickets/${ticketId}`,
    'ticket',
    `Freshdesk has no ticket ${ticketId} — it may have been deleted or merged.`,
    DESCRIPTION_TIMEOUT_MS
  );
  if (res.status !== 'ok') return res;
  const description = (res.body as { description?: unknown } | null)?.description;
  if (typeof description !== 'string') {
    console.error('[freshdesk] ticket: unexpected body');
    return unavailable('Freshdesk returned an unexpected response.');
  }
  return describeHtml(description);
}

// ---------------------------------------------------------------------------------------------
// Ticket views — live search, one ticket, its conversation. All READ-ONLY.
// ---------------------------------------------------------------------------------------------

/** Freshdesk's search page size and page ceiling: one expression yields at most 300 tickets. */
export const SEARCH_PAGE_SIZE = 30;
export const SEARCH_MAX_PAGES = 10;

export type TicketSummary = {
  id: string;
  subject: string;
  status: number;
  cfFeature: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type RawTicket = {
  id?: number | string;
  subject?: string | null;
  status?: number;
  created_at?: string | null;
  updated_at?: string | null;
  custom_fields?: { cf_feature?: string | null } | null;
  description?: string | null;
  requester?: { name?: string | null; email?: string | null } | null;
};

function summarise(t: RawTicket): TicketSummary | null {
  const id = t.id == null ? '' : String(t.id);
  if (!isFreshdeskId(id) || typeof t.status !== 'number') return null;
  const feature = t.custom_fields?.cf_feature;
  return {
    id,
    subject: t.subject ?? '',
    status: t.status,
    cfFeature: typeof feature === 'string' && feature.trim() ? feature.trim() : null,
    createdAt: t.created_at ?? null,
    updatedAt: t.updated_at ?? null,
  };
}

export type TicketSearchPage =
  | { status: 'ok'; tickets: TicketSummary[]; total: number }
  | Unavailable;

/**
 * One page (1-10) of `GET /search/tickets`. `expression` is Freshdesk's query language WITHOUT the
 * wrapping double quotes, which are added here. Callers build it from constants, never from input.
 */
export async function searchTickets(expression: string, page: number): Promise<TicketSearchPage> {
  const query = encodeURIComponent(`"${expression}"`);
  const res = await freshdeskGet(`/search/tickets?query=${query}&page=${page}`, 'ticket search');
  if (res.status !== 'ok') return res;
  const body = res.body as { results?: unknown; total?: unknown } | null;
  if (!body || !Array.isArray(body.results) || typeof body.total !== 'number') {
    console.error('[freshdesk] ticket search: unexpected body');
    return unavailable('Freshdesk returned an unexpected response.');
  }
  return {
    status: 'ok',
    tickets: (body.results as RawTicket[]).flatMap((t) => summarise(t) ?? []),
    total: body.total,
  };
}

export type TicketDetail = TicketSummary & {
  description: TicketDescriptionResult;
  requesterName: string | null;
  requesterEmail: string | null;
};

export type TicketDetailResult = { status: 'found'; ticket: TicketDetail } | Unavailable;

/**
 * One ticket with its requester. 🔴 `requesterEmail` is the customer's address: the caller decides
 * whether it may leave the server.
 */
export async function getTicketDetail(ticketId: string): Promise<TicketDetailResult> {
  if (!isFreshdeskId(ticketId)) return unavailable('Not a Freshdesk ticket id.');
  const res = await freshdeskGet(
    `/tickets/${ticketId}?include=requester`,
    'ticket detail',
    `Freshdesk has no ticket ${ticketId} — it may have been deleted or merged.`
  );
  if (res.status !== 'ok') return res;
  const raw = res.body as RawTicket | null;
  const summary = raw ? summarise(raw) : null;
  if (!raw || !summary || typeof raw.description !== 'string') {
    console.error('[freshdesk] ticket detail: unexpected body');
    return unavailable('Freshdesk returned an unexpected response.');
  }
  return {
    status: 'found',
    ticket: {
      ...summary,
      description: describeHtml(raw.description),
      requesterName: raw.requester?.name ?? null,
      requesterEmail: raw.requester?.email ?? null,
    },
  };
}

/** One visible message on a ticket: the customer's, or an agent's public reply. */
export type TicketMessage = {
  conversationId: string;
  from: 'customer' | 'agent';
  createdAt: string | null;
  text: string;
};

export type TicketConversationResult =
  /** `truncated`: the page cap was reached, so later messages may be missing. */
  { status: 'found'; messages: TicketMessage[]; truncated: boolean } | Unavailable;

/**
 * The customer's messages and the agents' PUBLIC replies, oldest first. Private notes are dropped,
 * and so is any message whose `private` flag is missing: only a strict `false` proves it was public.
 * 🔴 `text` is customer-written plain text: render it as text only.
 */
export async function getTicketConversation(ticketId: string): Promise<TicketConversationResult> {
  if (!isFreshdeskId(ticketId)) return unavailable('Not a Freshdesk ticket id.');
  const read = await readConversations(ticketId);
  if (read.status !== 'ok') return read;
  const messages = read.all
    .filter((c) => c.private === false && typeof c.incoming === 'boolean')
    .map((c) => ({
      conversationId: c.id == null ? '' : String(c.id),
      from: c.incoming ? ('customer' as const) : ('agent' as const),
      createdAt: c.created_at ?? null,
      text: (typeof c.body === 'string' && c.body
        ? convertHtml(c.body).text
        : c.body_text ?? ''
      ).trim(),
    }))
    .filter((m) => isFreshdeskId(m.conversationId) && m.text !== '')
    .sort((x, y) => (x.createdAt ?? '').localeCompare(y.createdAt ?? ''));
  return { status: 'found', messages, truncated: read.truncated };
}
