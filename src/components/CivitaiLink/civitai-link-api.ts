import { env } from '~/env/client';

export type CivitaiLinkInstance = {
  id: number;
  key: string;
  name: string | null;
  activated: boolean;
  origin: string | null;
  oauthPaired: boolean;
  createdAt: Date;
};

/**
 * Registrable domain (last two labels) of a hostname — `link.civitai.com` →
 * `civitai.com`. Assumes a 2-label registrable domain, which is all we deploy.
 *
 * This is a COMPARISON KEY for "would one host's cookie reach the other?", not a
 * cookie Domain, and it deliberately does NOT mirror `cookieDomainForHost`
 * (`~/server/auth/civ-cookie`). That function returns undefined (host-only
 * cookie) for `localhost`, for bare IPv4, and for ANY single-label host; this
 * one returns the last two labels, or the whole thing when there are fewer than
 * two. Safe here because BOTH sides of the comparison go through this same
 * function, so an identical host still compares equal and a host-only cookie is
 * still shared — `localhost` page + `http://localhost:3000` Link host resolves
 * normally.
 *
 * Known imprecision, deliberately not fixed: two DIFFERENT private IPv4 hosts
 * (`10.0.0.1`, `192.168.0.1`) both key to `0.1` and so compare equal. That is a
 * false ACCEPT, which merely degrades to the pre-existing behaviour of issuing
 * the request and getting a 401 — never a false refusal of a working origin.
 */
const registrableDomain = (hostname: string): string => hostname.split('.').slice(-2).join('.');

/**
 * Resolve the Civitai Link service base URL for the current host, or
 * `undefined` when the service cannot authenticate this origin at all.
 *
 * `NEXT_PUBLIC_CIVITAI_LINK` (e.g. https://link.civitai.com) is baked at build
 * time and identical for the .com and .red builds. But the Link service
 * authenticates via the civitai session cookie, which after the .com/.red
 * split is domain-scoped to the host the user logged in on. A .red user's
 * cookie never reaches link.civitai.com, so the request 401s and key
 * generation hangs forever (ClickUp 868k49796). Target the same-registrable-
 * domain link.civitai.red instead so the .civitai.red cookie is sent.
 *
 * The `.red` rewrite only covers the one color we happen to run a Link host
 * for. Every OTHER origin this app is served from hits the same cookie problem
 * with no rewrite to save it, so refuse to build a URL we know cannot carry a
 * credential:
 *   - PR previews (`pr-N.civitaic.com`) — the session cookie is scoped to
 *     `civitaic.com` and `SameSite=Lax`, so neither the preview's own cookie nor
 *     a civitai.com cookie in the same browser is sent to link.civitai.com. A
 *     preview's civ-token is also minted by a different auth hub than the one
 *     the Link service verifies against, so it would be rejected even if it
 *     arrived.
 *   - `civitai.green` — no `link.civitai.green` host exists.
 * Both surfaced as `Error loading instances: Civitai Link request failed
 * (401 )`. Returning undefined lets callers disable the feature cleanly instead
 * of firing a request that can never succeed.
 *
 * Runs in both window and SharedWorker contexts (`globalThis.location`).
 */
export const getCivitaiLinkBaseUrl = (): string | undefined => {
  const base = env.NEXT_PUBLIC_CIVITAI_LINK;
  if (!base) return base;
  const host = (
    globalThis as { location?: { hostname?: string } }
  ).location?.hostname?.toLowerCase();
  // No location (SSR / node): keep the baked value. The same-domain check below
  // is a CLIENT decision — deciding it server-side would make SSR and hydration
  // disagree about whether the feature exists.
  if (!host) return base;

  const isRed = host === 'civitai.red' || host.endsWith('.civitai.red');
  const resolved = isRed ? base.replace('.civitai.com', '.civitai.red') : base;

  let resolvedHost: string;
  try {
    resolvedHost = new URL(resolved).hostname.toLowerCase();
  } catch {
    // Defence in depth on a branch that should be UNREACHABLE: `~/env/client`
    // parses this var with `z.url()` and throws on failure in EVERY environment
    // (the dev schema's `.optional()` widens presence, not format), and zod's
    // `z.url()` is itself `new URL(...)` — the same constructor as here. The
    // load-bearing step is that zod validates the TRIMMED string and writes that
    // trimmed value BACK, so what lands in `env` is exactly the string it
    // proved; without the write-back a leading NBSP or BOM would pass `z.url()`
    // and still throw here. The `.civitai.com`→`.civitai.red` substitution
    // cannot invalidate it either. KEEP THE CATCH: "unreachable" rests on that
    // zod behaviour, not on anything this file controls.
    // Deliberately no special-case reporting here: an earlier revision logged a
    // "config error" on the theory that dev skips URL validation, which is
    // false, so the log could never fire.
    return undefined;
  }
  if (registrableDomain(host) !== registrableDomain(resolvedHost)) return undefined;

  return resolved;
};

const clFetch = async (url: string, options: RequestInit = {}) => {
  const base = getCivitaiLinkBaseUrl();
  if (!base) throw new Error('Civitai Link URL not set');

  if (!url.startsWith('/')) url = '/' + url;
  const response = await fetch(base + url, {
    ...options,
    credentials: 'include',
  });
  // Surface failures instead of returning {}: a non-array body silently became
  // `instances` and downstream `.find` threw "a.find is not a function" while
  // the UI spun forever. Throwing lets the worker's catch emit a real error.
  if (!response.ok) {
    throw new Error(`Civitai Link request failed (${response.status} ${response.statusText})`);
  }
  return response.json() as unknown;
};

export const getLinkInstances = async () => {
  const result = await clFetch('/api/link');
  return (Array.isArray(result) ? result : []) as CivitaiLinkInstance[];
};

export const createLinkInstance = async (id?: number) => {
  return (await clFetch(`/api/link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: id ? JSON.stringify({ id }) : JSON.stringify({}),
  })) as { id: number; key: string; instanceCount: number; instanceLimit: number; name: string };
};

export const updateLinkInstance = async (data: { id: number; name: string }) => {
  if (!data.id) throw new Error('Missing id');

  return (await clFetch(`/api/link`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })) as { id: number; name: string };
};

export const deleteLinkInstance = async (id: number) => {
  return (await clFetch(`/api/link?id=${id}`, {
    method: 'DELETE',
  })) as { success: boolean };
};
