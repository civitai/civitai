import { env } from '$env/dynamic/private';

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
  | { status: 'unavailable'; reason: string };

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

/** One public reply an agent sent on a ticket. */
export type AgentReply = { conversationId: string; createdAt: string | null; text: string };

export type AgentRepliesResult =
  | { status: 'found'; replies: AgentReply[] }
  | { status: 'none' }
  | { status: 'unavailable'; reason: string };

/** Conversations per page — Freshdesk's maximum. */
export const CONVERSATIONS_PER_PAGE = 100;
/** Pages read before stopping. A ticket past this many conversations offers only its earliest. */
export const CONVERSATION_PAGE_CAP = 5;

type RawConversation = {
  id?: number | string;
  incoming?: boolean;
  private?: boolean;
  body_text?: string | null;
  created_at?: string | null;
};

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
 * answered. Never throws.
 *
 * ⚠️ Freshdesk rate-limits per ACCOUNT, not per key, so every call here draws on the same hourly pool
 * as every other integration using the account. It runs on a moderator's click only.
 */
export async function getPublicAgentReplies(ticketId: string): Promise<AgentRepliesResult> {
  const key = env.FRESHDESK_API_KEY;
  if (!key) return { status: 'unavailable', reason: 'Freshdesk is not configured.' };
  if (!/^\d{1,20}$/.test(ticketId))
    return { status: 'unavailable', reason: 'Not a Freshdesk ticket id.' };

  const auth = Buffer.from(`${key}:X`).toString('base64');
  const base = `https://${freshdeskHost()}/api/v2/tickets/${ticketId}/conversations`;
  const all: RawConversation[] = [];
  try {
    for (let page = 1; page <= CONVERSATION_PAGE_CAP; page++) {
      const res = await fetch(`${base}?per_page=${CONVERSATIONS_PER_PAGE}&page=${page}`, {
        headers: { authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404)
        return {
          status: 'unavailable',
          reason: `Freshdesk has no ticket ${ticketId} — it may have been deleted or merged.`,
        };
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after'));
        return {
          status: 'unavailable',
          reason: `Freshdesk's rate limit is reached${
            Number.isFinite(wait) && wait > 0 ? ` — try again in ${wait}s` : ''
          }.`,
        };
      }
      if (!res.ok) {
        console.error('[freshdesk] conversations failed', res.status);
        return { status: 'unavailable', reason: `Freshdesk returned ${res.status}.` };
      }
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) {
        console.error('[freshdesk] conversations: unexpected body');
        return { status: 'unavailable', reason: 'Freshdesk returned an unexpected response.' };
      }
      all.push(...(body as RawConversation[]));
      if (body.length < CONVERSATIONS_PER_PAGE) break;
    }
  } catch (e) {
    console.error('[freshdesk] conversations error', e);
    return { status: 'unavailable', reason: 'Freshdesk did not respond.' };
  }

  const replies = all
    .filter((c) => c.incoming === false && c.private === false)
    .map((c) => ({
      conversationId: c.id == null ? '' : String(c.id),
      createdAt: c.created_at ?? null,
      text: (c.body_text ?? '').trim(),
    }))
    .filter((r) => /^\d{1,20}$/.test(r.conversationId) && r.text !== '')
    // ISO-8601 timestamps sort as strings; a reply with none sorts last.
    .sort((x, y) => (y.createdAt ?? '').localeCompare(x.createdAt ?? ''));
  return replies.length > 0 ? { status: 'found', replies } : { status: 'none' };
}

export async function getFreshdeskContact(email: string | null): Promise<FreshdeskResult> {
  const key = env.FRESHDESK_API_KEY;
  const domain = freshdeskHost();
  if (!key) return { status: 'unavailable', reason: 'Freshdesk is not configured.' };
  if (!email) return { status: 'unavailable', reason: 'This account has no email address.' };

  // Freshdesk authenticates with the API key as the basic-auth username and any password.
  const auth = Buffer.from(`${key}:X`).toString('base64');
  const query = encodeURIComponent(`"email:'${email.replace(/'/g, '')}'"`);

  try {
    const res = await fetch(`https://${domain}/api/v2/search/contacts?query=${query}`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error('[freshdesk] search failed', res.status);
      return { status: 'unavailable', reason: `Freshdesk returned ${res.status}.` };
    }
    const body = (await res.json()) as {
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
        url: `https://${domain}/a/contacts/${hit.id}`,
      },
    };
  } catch (e) {
    console.error('[freshdesk] lookup error', e);
    return { status: 'unavailable', reason: 'Freshdesk did not respond.' };
  }
}
