import type { IncomingMessage } from 'http';
import { getUserContentSettings } from '~/server/services/user.service';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getTosMeta } from '~/server/services/content.service';
import { getCurrentAnnouncements } from '~/server/services/announcement.service';
import { getNavBanners } from '~/server/services/nav-banner.service';
import { getActiveSiteAlerts } from '~/server/services/site-alert.service';
import { getUserFollows } from '~/server/redis/caches';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { getBrowsingSettingAddons, getLiveNow } from '~/server/services/system-cache';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import { env } from '~/env/server';
import { env as clientEnv } from '~/env/client';
import { logToAxiom } from '~/server/logging/client';

/**
 * The per-user settings bootstrap: the session plus every ambient seed a page needs on its
 * first paint. ONE implementation, two callers —
 *
 *   - `/api/user/settings`, over HTTP;
 *   - `_app.getInitialProps`, in-process during a server render
 *     (`resolveSettingsBootstrapForRender` below).
 *
 * 🔴 SERVER ONLY. This module reaches the database, redis, the server env and `fs`. `_app` is
 * compiled into the client bundle too, so its one import of this file must stay a dynamic
 * `import()` inside an `if (typeof window === 'undefined') { … }` BLOCK — the form both
 * bundlers drop from the client build. `no-server-infra-in-app-graph.test.ts` pins that edge.
 */

type AuthArgs = Parameters<typeof getServerAuthSession>[0];

/** What the route answers with, and what a server render is seeded from. */
export const SETTINGS_BOOTSTRAP_PATH = '/api/user/settings';

/**
 * A member that never replies would pin every page on it, and a `.catch` cannot answer a
 * parked read — only a deadline can. Timing out is reported, not swallowed: the incident this
 * exists to prevent was invisible precisely because nothing logged.
 */
function settle<T, F>(promise: Promise<T>, fallback: F, member: string): Promise<T | F> {
  const timeoutMs = env.SETTINGS_READ_DEADLINE_MS;
  return withTimeoutFallback<T | F>(promise, timeoutMs, fallback, () => {
    logToAxiom(
      {
        type: 'warning',
        name: 'settings bootstrap deadline',
        message: `${member} exceeded ${timeoutMs}ms`,
        member,
        timeoutMs,
      },
      'settings'
    ).catch();
  }).catch(() => fallback);
}

/**
 * Rejects only when the session lookup does. Every other member degrades on its own, so the
 * returned object ALWAYS carries a `session` key — present-but-null means "signed out", and
 * callers rely on telling that apart from a failed bootstrap, which has no payload at all.
 */
export async function resolveSettingsBootstrap({ req, res }: AuthArgs) {
  // Deliberately unbounded: failing this open renders a logged-in user anonymous, which
  // `_app`'s hasAuthCookie carve-out exists to avoid.
  const session = await getServerAuthSession({ req, res });
  return resolveSettingsBootstrapSeeds(req, session);
}

/** The bootstrap's `session`: a session with no user fields is "signed out", never a session. */
export function bootstrapSession(session: Awaited<ReturnType<typeof getServerAuthSession>>) {
  return session?.user && Object.keys(session.user).length > 0 ? session : null;
}

/**
 * Everything in the bootstrap after the session lookup, for an already-resolved session. Split out
 * so a caller can decide on the session (e.g. a feature flag) before paying for the seeds.
 */
export async function resolveSettingsBootstrapSeeds(
  req: AuthArgs['req'],
  session: Awaited<ReturnType<typeof getServerAuthSession>>
) {
  // Concurrent, to keep this hot per-bootstrap read off the critical path.
  // EVERY member swallows its own errors: a single rejection fails the whole
  // bootstrap, which `_app` reads as "degraded" — so one blip would drop the
  // session seed and the browsing-settings addons too.
  const domainColor = getRequestDomainColor(req);
  const [
    settings,
    tosMeta,
    announcements,
    following,
    browsingSettingsAddons,
    liveNow,
    navBanners,
    siteAlerts,
  ] = await Promise.all([
    // Content-settings view so SSR initialData matches the tRPC getSettings response
    // shape. `undefined` — NOT `{}` — because AppProvider passes this straight to
    // `useQuery({ initialData })` under a global `staleTime: Infinity`: any defined
    // value is fresh from frame 0 and never refetched, and an empty one resolves
    // showNsfw/blurNsfw off the JWT, which lags a user who just turned nsfw OFF.
    // `undefined` leaves the query unseeded so it fetches and self-heals, matching
    // what `_app` already does on its degraded path.
    settle(getUserContentSettings(session?.user?.id ?? -1), undefined, 'getUserContentSettings'),
    // The static per-domain ToS metadata. Resolved here because `content.service` reads
    // `fs/promises`, which must never be imported into `_app`'s client-bundled graph. The
    // show/hide decision is computed client-side against the seeded `user.getSettings`,
    // so this is user-independent and we can resolve it for everyone (it's cheap +
    // cached). Domain fallback matches createContext's
    // `getRequestDomainColor(req) ?? 'blue'`.
    // `undefined` on failure: `useToSUpdateModal` guards on it and simply
    // doesn't prompt, which beats degrading the whole payload.
    settle(getTosMeta({ domainColor: domainColor ?? 'blue' }), undefined, 'getTosMeta'),
    // Seeds the ambient `announcement.getAnnouncements` query (fires on every
    // bootstrap, anon + authed). Match the resolver byte-for-byte: its
    // `applyRequestDomainColor` middleware overrides the client input with
    // `getRequestDomainColor(req)` (NO 'blue' fallback), so we pass the same raw
    // value here. On failure fall back to undefined and let the client self-heal
    // via a live fetch.
    settle(
      getCurrentAnnouncements({ domain: domainColor, userId: session?.user?.id }),
      undefined,
      'getCurrentAnnouncements'
    ),
    // Seeds the ambient, auth-gated `user.getFollowingUsers` query (fires
    // on every logged-in bootstrap wherever a follow/notify button mounts).
    // `getUserFollows` is the same redis-cached fn the resolver calls, so the
    // seed is byte-identical (a `number[]` of followed userIds). Anon never
    // fires this query (`enabled: !!currentUser`), so seed authed-only.
    session?.user
      ? settle(getUserFollows(session.user.id), undefined, 'getUserFollows')
      : Promise.resolve(undefined),
    // Global, user-independent sysRedis reads.
    //
    // `getBrowsingSettingAddons` fails OPEN internally — a redis reject, a
    // `withSysReadDeadline` timeout and corrupt JSON all RETURN
    // DEFAULT_BROWSING_SETTINGS_ADDONS rather than throwing. So on degraded
    // sysRedis the client is seeded with the defaults, and because the provider
    // passes this to `useQuery({ initialData, staleTime: Infinity })` they are
    // pinned for the session; the live config is only picked up on the next
    // bootstrap. Telling "live config" apart from "failed open" would need a
    // sentinel out of system-cache. `undefined` on the deadline path for the same
    // reason the old `.catch` used it — react-query treats a `[]` seed as valid
    // data and pins it as "no restrictions".
    settle(getBrowsingSettingAddons(), undefined, 'getBrowsingSettingAddons'),
    settle(getLiveNow(), false, 'getLiveNow'),
    // Seeds `event.getNavBanners` so the nav strip is in the first paint and never shifts
    // the page. Session-only (no cookies), so the anonymous answer is the same for every
    // anonymous caller, as the route's public cache header requires.
    settle(getNavBanners({ viewer: session?.user }), undefined, 'getNavBanners'),
    settle(getActiveSiteAlerts(), undefined, 'getActiveSiteAlerts'),
  ]);
  return {
    settings,
    tosMeta,
    announcements,
    following,
    browsingSettingsAddons,
    liveNow,
    navBanners,
    siteAlerts,
    session: bootstrapSession(session),
  };
}

/**
 * Ceiling on the WHOLE bootstrap during a server render. The per-member deadlines above leave
 * one thing unbounded on purpose — the session lookup — and this is what stops a parked lookup
 * from parking every page: past it, the render goes ahead without a bootstrap.
 *
 * 8s only trips on a genuine hang; a slow-but-successful bootstrap should not be thrown away
 * for a degraded render. Env-overridable, clamped to a 1s floor so a zero or negative override
 * cannot turn every render into the degraded one.
 */
const RENDER_DEADLINE_MS = Math.max(
  1000,
  Number(process.env.APP_SETTINGS_FETCH_TIMEOUT_MS) || 8000
);

const TIMED_OUT = Symbol('settings bootstrap timed out');

/**
 * The `Host` the bootstrap saw when `_app` reached it over HTTP. That request went to the
 * internal base URL, and Node's `fetch` replaces a caller-supplied `Host` with the URL's own
 * (measured on Node 24.19 and 24.21: a forwarded `Host: civitai.com` arrived as the URL's
 * `host:port`). So the route never saw the page's public host, and everything it derives from
 * the host — the domain colour behind the ToS fields and the domain-targeted announcements —
 * resolved for the internal host. Rendering with the page's host would change both on first
 * paint. Derived exactly as `_app` derived that URL; whether a render SHOULD see the public
 * host is a separate product question, not part of moving this call in-process.
 *
 * No base URL rejects, as the fetch to `undefined/...` did: the render degrades.
 */
function bootstrapHost(): string {
  const baseUrl = process.env.NEXTAUTH_URL_INTERNAL ?? clientEnv.NEXT_PUBLIC_BASE_URL;
  try {
    return new URL(SETTINGS_BOOTSTRAP_PATH, baseUrl).host;
  } catch {
    throw new Error('settings bootstrap has no usable base URL');
  }
}

type BootstrapSourceRequest = IncomingMessage & { cookies?: Partial<Record<string, string>> };

/**
 * The request the settings bootstrap reads, built from a page's (or page-data endpoint's) own
 * request. ONE builder for every in-process caller, so they cannot drift:
 *
 *   - URL: always `SETTINGS_BOOTSTRAP_PATH`, never the caller's. `getServerAuthSession` treats a
 *     `?token=` query parameter as an API credential, and a page URL may carry an unrelated one —
 *     it must never replace the cookie viewer.
 *   - Headers and cookies: the caller's, so the session is the caller's.
 *   - Host: the internal bootstrap host by default (`bootstrapHost`), which is what the seeds were
 *     built against. `host` overrides it for a session lookup whose cookie writes reach the browser:
 *     the rolled cookie's Domain is derived from it, so it must be the viewer's own host.
 *   - Its own `req.context`, unless `context` is passed: whatever the session lookup records (the
 *     credential) lands there, never on the caller's request by accident.
 */
export function settingsBootstrapRequest(
  request: BootstrapSourceRequest,
  { host, context }: { host?: string; context?: Record<string, unknown> } = {}
): AuthArgs['req'] {
  // The bootstrap reads only `authorization` and `host` from the headers (plus the parsed cookies).
  return {
    headers: { ...request.headers, host: host ?? bootstrapHost() },
    cookies: request.cookies,
    url: SETTINGS_BOOTSTRAP_PATH,
    ...(context ? { context } : {}),
  } as unknown as AuthArgs['req'];
}

/**
 * The bootstrap for a page that is being server-rendered, with no HTTP request to ourselves.
 *
 * It answers exactly what `_app`'s old `fetch` of `SETTINGS_BOOTSTRAP_PATH` at the internal
 * base URL, forwarding the page request's headers, would have answered, because that is what
 * callers were built against:
 *
 *   - `Host` is the internal base URL's, not the page's — `bootstrapHost` says why.
 *   - The session is resolved from the page request's HEADERS AND COOKIES ONLY, never its
 *     URL. `getServerAuthSession` treats a `?token=` query parameter as an API credential,
 *     and a page URL may carry an unrelated one.
 *   - Its own `req.context`, so nothing it records lands on the page request.
 *   - Cookie writes are discarded. The session lookup can roll or upgrade the session cookie
 *     on the response it is handed; over HTTP that response was this internal call's own and
 *     was never forwarded to the browser. Sending those cookies on the document response is
 *     a change to session-cookie behaviour and does not belong in a transport swap.
 *   - JSON round-tripped, so a `Date` reaches the render as the same string the browser gets
 *     from `__NEXT_DATA__`, and server and client render from identical values.
 *
 * Rejects on a failed session lookup or past the deadline. The caller must treat a rejection
 * as "no bootstrap", NOT as "signed out".
 */
export async function resolveSettingsBootstrapForRender(
  request: BootstrapSourceRequest
): Promise<unknown> {
  // Every other request field the bootstrap reads is the page's own, unchanged: `fetch`
  // forwarded `authorization` and `cookie` as-is.
  const req = settingsBootstrapRequest(request);
  const res = {
    getHeader: () => undefined,
    setHeader: () => undefined,
  } as unknown as AuthArgs['res'];

  // `_app` interpolates the rejection's message into its `console.warn` marker line. Over HTTP the
  // route's own catch swallowed these, so a raw message never reached that line; database clients
  // put connection details in theirs, so only the name and code travel there. The full message
  // goes through the structured logger instead — the sink the deadline warning above and the
  // central error handlers use (it writes its own JSON line too) — so the reason is recoverable.
  const bootstrap = resolveSettingsBootstrap({ req, res }).catch((e: unknown) => {
    const code = (e as { code?: unknown } | null)?.code;
    const name = e instanceof Error ? e.name : 'unknown';
    logToAxiom(
      {
        type: 'warning',
        name: 'settings bootstrap failed',
        message: e instanceof Error ? e.message : String(e),
      },
      'settings'
    ).catch();
    throw new Error(
      `settings bootstrap failed: ${[name, typeof code === 'string' ? code : undefined]
        .filter(Boolean)
        .join(' ')}`
    );
  });
  const payload = await withTimeoutFallback<
    Awaited<ReturnType<typeof resolveSettingsBootstrap>> | typeof TIMED_OUT
  >(bootstrap, RENDER_DEADLINE_MS, TIMED_OUT);
  if (payload === TIMED_OUT) {
    throw new Error(`settings bootstrap timed out after ${RENDER_DEADLINE_MS}ms`);
  }
  return JSON.parse(JSON.stringify(payload));
}

/**
 * The bootstrap members that are the same for every viewer, for a static shell render
 * (`~/server/shell/shell-mode`): read from the same request a full render's bootstrap reads, with
 * no session lookup and nothing per user. The viewer's own members arrive with the page data.
 * Never rejects: each member degrades as it does in the full bootstrap.
 */
export async function resolveShellSeeds(request: BootstrapSourceRequest) {
  let domainColor: ReturnType<typeof getRequestDomainColor> | undefined;
  try {
    domainColor = getRequestDomainColor(settingsBootstrapRequest(request));
  } catch {
    domainColor = undefined;
  }
  const [tosMeta, browsingSettingsAddons, liveNow] = await Promise.all([
    settle(getTosMeta({ domainColor: domainColor ?? 'blue' }), undefined, 'getTosMeta'),
    settle(getBrowsingSettingAddons(), undefined, 'getBrowsingSettingAddons'),
    settle(getLiveNow(), false, 'getLiveNow'),
  ]);
  // JSON round-tripped as the full render's bootstrap is, so server and client read equal values.
  return JSON.parse(JSON.stringify({ tosMeta, browsingSettingsAddons, liveNow })) as {
    tosMeta?: Awaited<ReturnType<typeof getTosMeta>>;
    browsingSettingsAddons?: Awaited<ReturnType<typeof getBrowsingSettingAddons>>;
    liveNow: boolean;
  };
}
