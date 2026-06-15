import type { getProviders } from 'next-auth/react';
import { createAuthOptions } from '~/server/auth/next-auth-options';

/**
 * In-process replacement for next-auth's `getProviders()` on the SERVER.
 *
 * `getProviders()` from `next-auth/react`, when called in a server context
 * (tRPC query / `getServerSideProps`), resolves the OAuth provider list by
 * doing an outbound HTTP SELF-FETCH to this pod's own
 * `${NEXTAUTH_URL_INTERNAL}/api/auth/providers` (via `fetchData` in
 * `next-auth/client/_utils`). That internal fetch is **un-timed** and exposes
 * no abort hook, so during an outbound-HTTP slowdown it hangs until the socket
 * finally resolves — on api-primary that pins past Traefik's 30s forwarding
 * ceiling and the request returns HTTP 504, and even when it succeeds it leaves
 * a dangling self-socket on the hottest pool. This is the same self-amplifying
 * "resolve auth by round-tripping my own serving capacity" class PR #2502 fixed
 * on the SSR `/api/user/settings` self-fetch.
 *
 * The provider list is **static config** — it is built deterministically from
 * `authOptions.providers` and a base URL, with no per-request I/O. So instead of
 * fetching it we build it in-process, reproducing EXACTLY what next-auth's
 * `/api/auth/providers` route returns:
 *
 *  - next-auth's route builder (`core/routes/providers.ts`) emits, per provider,
 *    `{ id, name, type, signinUrl, callbackUrl }` keyed by `id`.
 *  - `signinUrl`/`callbackUrl` are `${base}/signin/${id}` / `${base}/callback/${id}`
 *    (`core/lib/providers.ts` → `parseProviders`).
 *  - the effective `id`/`name` honor a provider's user-supplied `options`
 *    overriding the factory defaults (next-auth deep-merges `options` over the
 *    provider, so e.g. `CredentialsProvider({ id: 'account-switch', name: '…' })`
 *    surfaces as id `account-switch`, not `credentials`).
 *  - `base` is `detectOrigin()` (`core/index.ts`): the forwarded host when
 *    `AUTH_TRUST_HOST`/`VERCEL` is set, else `NEXTAUTH_URL`, run through
 *    `parseUrl()` (default path `/api/auth`, trailing slash stripped).
 *
 * `createAuthOptions(req)` is host-aware (it filters providers per request host),
 * so passing the caller's request keeps the result identical to what the live
 * route would have returned for that same host.
 *
 * Only the client-safe fields (`id, name, type, signinUrl, callbackUrl`) are
 * emitted — never `clientSecret`, `authorization`, or any other config — exactly
 * as next-auth's route builder does.
 */

type Providers = Awaited<ReturnType<typeof getProviders>>;
// The non-null variant of `Providers` is a `Record` keyed by a `LiteralUnion`,
// which TS treats as requiring every built-in provider key when constructed from
// an object literal. We accumulate into an open string-keyed map (next-auth does
// the same: `providers.reduce(..., {})`) and cast to the public type on return.
type ProviderMap = NonNullable<Providers>;

// Mirror of next-auth's `utils/parse-url.ts` (v4.24.11): normalize a base URL
// the same way the providers route does, so the absolute signin/callback URLs
// are byte-identical to the self-fetched response.
function parseUrlBase(url?: string | null): string {
  const defaultUrl = new URL('http://localhost:3000/api/auth');
  let input = url ?? undefined;
  if (input && !input.startsWith('http')) {
    input = `https://${input}`;
  }
  const parsed = new URL(input ?? defaultUrl.toString());
  const path = (parsed.pathname === '/' ? defaultUrl.pathname : parsed.pathname).replace(/\/$/, '');
  return `${parsed.origin}${path}`;
}

// Mirror of next-auth's `utils/detect-origin.ts` (v4.24.11). next-auth reads raw
// `process.env` (NOT the validated env schema) here, so we do too.
function detectOrigin(forwardedHost?: string, protocol?: string): string | undefined {
  if (process.env.VERCEL ?? process.env.AUTH_TRUST_HOST) {
    return `${protocol === 'http' ? 'http' : 'https'}://${forwardedHost}`;
  }
  return process.env.NEXTAUTH_URL;
}

type ProvidersReqHeaders = {
  host?: string;
  'x-forwarded-host'?: string | string[];
  'x-forwarded-proto'?: string | string[];
};

type ProvidersReq = {
  url?: string;
  headers: ProvidersReqHeaders;
};

function firstHeader(value?: string | string[]): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Build the OAuth provider list in-process, equivalent to the server-side result
 * of `getProviders()` (i.e. the body of `/api/auth/providers`). No HTTP fetch.
 *
 * Returns `Record<string, ClientSafeProvider> | null` — `null` only when there
 * are zero configured providers, matching next-auth's "empty body → null"
 * contract (`fetchData` returns `null` when the response object has no keys).
 */
export function getProvidersInProcess(req?: ProvidersReq): Providers {
  const options = createAuthOptions(req as any);
  const providers = options.providers ?? [];

  if (providers.length === 0) return null;

  // Match `detectOrigin(x-forwarded-host ?? host, x-forwarded-proto)` exactly.
  const headers = req?.headers ?? {};
  const forwardedHost = firstHeader(headers['x-forwarded-host']) ?? headers.host;
  const forwardedProto = firstHeader(headers['x-forwarded-proto']);
  const base = parseUrlBase(detectOrigin(forwardedHost, forwardedProto));

  const result: Record<string, ProviderMap[string]> = {};
  for (const provider of providers) {
    // next-auth deep-merges a provider's `options` over its factory defaults,
    // so user-supplied id/name win (matches `parseProviders`).
    const opts = (provider as { options?: { id?: string; name?: string } }).options;
    const id = opts?.id ?? provider.id;
    const name = opts?.name ?? provider.name;
    const type = provider.type;
    result[id] = {
      id,
      name,
      type,
      signinUrl: `${base}/signin/${id}`,
      callbackUrl: `${base}/callback/${id}`,
    };
  }

  return result as ProviderMap;
}
