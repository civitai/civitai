import { getUserContentSettings } from '~/server/services/user.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getTosMeta } from '~/server/services/content.service';
import { getCurrentAnnouncements } from '~/server/services/announcement.service';
import { getUserFollows } from '~/server/redis/caches';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { getBrowsingSettingAddons, getLiveNow } from '~/server/services/system-cache';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

/**
 * `_app` self-fetches this route on every SSR render, so a member that never replies pins
 * every page at that fetch's own abort and renders it signed-out. A `.catch` cannot answer
 * a parked read — only a deadline can. Timing out is reported, not swallowed: the incident
 * this exists to prevent was invisible precisely because nothing logged.
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

export default PublicEndpoint(
  async function handler(req, res) {
    try {
      // Deliberately unbounded: failing this open renders a logged-in user anonymous, which
      // `_app`'s hasAuthCookie carve-out exists to avoid.
      const session = await getServerAuthSession({ req, res });
      // Concurrent, to keep this hot per-bootstrap route off the critical path.
      // EVERY member swallows its own errors: a single rejection diverts the whole
      // payload to the outer catch, which `_app` reads as "endpoint degraded" — so
      // one blip would drop the session seed and the browsing-settings addons too.
      const domainColor = getRequestDomainColor(req);
      const [settings, tosMeta, announcements, following, browsingSettingsAddons, liveNow] =
        await Promise.all([
          // Content-settings view so SSR initialData matches the tRPC getSettings response
          // shape. `undefined` — NOT `{}` — because AppProvider passes this straight to
          // `useQuery({ initialData })` under a global `staleTime: Infinity`: any defined
          // value is fresh from frame 0 and never refetched, and an empty one resolves
          // showNsfw/blurNsfw off the JWT, which lags a user who just turned nsfw OFF.
          // `undefined` leaves the query unseeded so it fetches and self-heals, matching
          // what `_app` already does on its degraded path.
          settle(
            getUserContentSettings(session?.user?.id ?? -1),
            undefined,
            'getUserContentSettings'
          ),
          // Resolve the static per-domain ToS metadata here (server-only API route)
          // so `_app` getInitialProps can deliver it WITHOUT importing
          // `content.service` — which pulls `fs/promises` into `_app`'s client-bundled
          // graph and breaks the build. The show/hide decision is computed client-side
          // against the seeded `user.getSettings`, so this is user-independent and we
          // can resolve it for everyone (it's cheap + cached). Domain fallback matches
          // createContext's `getRequestDomainColor(req) ?? 'blue'`.
          // `undefined` on failure: `useToSUpdateModal` guards on it and simply
          // doesn't prompt, which beats degrading the whole payload.
          settle(getTosMeta({ domainColor: domainColor ?? 'blue' }), undefined, 'getTosMeta'),
          // SSR-seed the ambient `announcement.getAnnouncements` query (fires on every
          // bootstrap, anon + authed). Computed here — NOT in `_app` getInitialProps —
          // because `announcement.service` is server-only and importing it into `_app`
          // leaks it into the client bundle. Match the resolver byte-for-byte: its
          // `applyRequestDomainColor` middleware overrides the client input with
          // `getRequestDomainColor(req)` (NO 'blue' fallback), so we pass the same raw
          // value here. On failure fall back to undefined and let the client self-heal
          // via a live fetch.
          settle(
            getCurrentAnnouncements({ domain: domainColor, userId: session?.user?.id }),
            undefined,
            'getCurrentAnnouncements'
          ),
          // SSR-seed the ambient, auth-gated `user.getFollowingUsers` query (fires
          // on every logged-in bootstrap wherever a follow/notify button mounts).
          // `getUserFollows` is the same redis-cached fn the resolver calls, so the
          // seed is byte-identical (a `number[]` of followed userIds). Anon never
          // fires this query (`enabled: !!currentUser`), so seed authed-only.
          session?.user
            ? settle(getUserFollows(session.user.id), undefined, 'getUserFollows')
            : Promise.resolve(undefined),
          // Global, user-independent sysRedis reads moved off `_app` getInitialProps:
          // importing `system-cache` there pulled `~/server/db/client` (Prisma) and
          // `~/server/redis/client` into `_app`'s CLIENT-bundled module graph, since
          // getInitialProps also runs in the browser on client-side transitions.
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
        ]);
      res.status(200).json({
        settings,
        tosMeta,
        announcements,
        following,
        browsingSettingsAddons,
        liveNow,
        session: session?.user && Object.keys(session.user).length > 0 ? session : null,
      });
    } catch (e) {
      res.status(200).json({});
    }
  },
  ['GET']
);
