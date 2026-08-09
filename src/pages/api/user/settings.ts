import { getUserContentSettings } from '~/server/services/user.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getTosMeta } from '~/server/services/content.service';
import { getCurrentAnnouncements } from '~/server/services/announcement.service';
import { getUserFollows } from '~/server/redis/caches';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { getBrowsingSettingAddons, getLiveNow } from '~/server/services/system-cache';

export default PublicEndpoint(
  async function handler(req, res) {
    try {
      const session = await getServerAuthSession({ req, res });
      // Use the content-settings view so SSR initialData matches the tRPC
      // getSettings response shape (JSON settings + User-column toggles).
      const settings = await getUserContentSettings(session?.user?.id ?? -1);
      // tosMeta + announcements + following are computed concurrently to keep this
      // hot per-bootstrap route off the critical path. announcements + following
      // swallow their own errors (`.catch`) so they can never reject the Promise.all
      // and drop the critical settings/session payload; tosMeta (static, no user
      // input) can still throw to the outer catch (preserving prior behaviour).
      const domainColor = getRequestDomainColor(req);
      const [tosMeta, announcements, following, browsingSettingsAddons, liveNow] =
        await Promise.all([
          // Resolve the static per-domain ToS metadata here (server-only API route)
          // so `_app` getInitialProps can deliver it WITHOUT importing
          // `content.service` — which pulls `fs/promises` into `_app`'s client-bundled
          // graph and breaks the build. The show/hide decision is computed client-side
          // against the seeded `user.getSettings`, so this is user-independent and we
          // can resolve it for everyone (it's cheap + cached). Domain fallback matches
          // createContext's `getRequestDomainColor(req) ?? 'blue'`.
          getTosMeta({ domainColor: domainColor ?? 'blue' }),
          // SSR-seed the ambient `announcement.getAnnouncements` query (fires on every
          // bootstrap, anon + authed). Computed here — NOT in `_app` getInitialProps —
          // because `announcement.service` is server-only and importing it into `_app`
          // leaks it into the client bundle. Match the resolver byte-for-byte: its
          // `applyRequestDomainColor` middleware overrides the client input with
          // `getRequestDomainColor(req)` (NO 'blue' fallback), so we pass the same raw
          // value here. On failure fall back to undefined and let the client self-heal
          // via a live fetch.
          getCurrentAnnouncements({ domain: domainColor, userId: session?.user?.id }).catch(
            () => undefined
          ),
          // SSR-seed the ambient, auth-gated `user.getFollowingUsers` query (fires
          // on every logged-in bootstrap wherever a follow/notify button mounts).
          // `getUserFollows` is the same redis-cached fn the resolver calls, so the
          // seed is byte-identical (a `number[]` of followed userIds). Anon never
          // fires this query (`enabled: !!currentUser`), so seed authed-only.
          session?.user
            ? getUserFollows(session.user.id).catch(() => undefined)
            : Promise.resolve(undefined),
          // Global, user-independent sysRedis reads moved off `_app` getInitialProps:
          // importing `system-cache` there pulled `~/server/db/client` (Prisma) and
          // `~/server/redis/client` into `_app`'s CLIENT-bundled module graph, since
          // getInitialProps also runs in the browser on client-side transitions.
          //
          // `undefined` — NOT `[]` — is the failure value. The client provider passes
          // this straight to `useQuery({ initialData, staleTime: Infinity })`: an empty
          // array is VALID seed data, so it would pin the browsing-settings addons to
          // "no restrictions" for the whole session and never refetch. `undefined`
          // leaves the query unseeded, so it falls back to
          // DEFAULT_BROWSING_SETTINGS_ADDONS and self-heals on the next fetch.
          getBrowsingSettingAddons().catch(() => undefined),
          getLiveNow().catch(() => false),
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
