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

export async function getFreshdeskContact(email: string | null): Promise<FreshdeskResult> {
  const key = env.FRESHDESK_API_KEY;
  const domain = env.FRESHDESK_DOMAIN || 'civitai.freshdesk.com';
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
