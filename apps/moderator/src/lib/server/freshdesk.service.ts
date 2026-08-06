import { env } from '$env/dynamic/private';

// Support context for User Lookup (Retool's GetFreshdesk, ticket §1.2 "support context").
//
// Retool called civitai.freshdesk.com/api/v2/search/contacts directly with a hardcoded key. Here the key
// is FRESHDESK_API_KEY and the domain FRESHDESK_DOMAIN, matching the names the main app already uses.
//
// Returns null rather than throwing when unconfigured or unreachable: a missing support record must not
// blank an investigation panel, and the key is optional in development.

export type FreshdeskContact = {
  id: number;
  name: string | null;
  email: string | null;
  createdAt: string | null;
  url: string;
};

export async function getFreshdeskContact(email: string | null): Promise<FreshdeskContact | null> {
  const key = env.FRESHDESK_API_KEY;
  const domain = env.FRESHDESK_DOMAIN || 'civitai.freshdesk.com';
  if (!key || !email) return null;

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
      return null;
    }
    const body = (await res.json()) as {
      results?: { id: number; name?: string; email?: string; created_at?: string }[];
    };
    const hit = body.results?.[0];
    if (!hit) return null;
    return {
      id: hit.id,
      name: hit.name ?? null,
      email: hit.email ?? null,
      createdAt: hit.created_at ?? null,
      url: `https://${domain}/a/contacts/${hit.id}`,
    };
  } catch (e) {
    console.error('[freshdesk] lookup error', e);
    return null;
  }
}
