import { getUserContentSettings } from '~/server/services/user.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getTosMeta } from '~/server/services/content.service';
import { getCurrentAnnouncements } from '~/server/services/announcement.service';
import { getUserFollows } from '~/server/redis/caches';
import { getUnreadMessagesForUser } from '~/server/services/chat.service';
import { getUserNotificationCounts } from '~/server/services/notification.service';
import { getRequestDomainColor } from '~/server/utils/server-domain';

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
      const [tosMeta, announcements, following, chatUnreadCount, notificationCounts] =
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
        // SSR-seed the ambient, auth-gated `chat.getUnreadCount` query (~19 req/s
        // on api-primary; the always-visible header chat badge). Computed here —
        // NOT in `_app` getInitialProps — because `chat.service` is server-only
        // and importing it into `_app` (even via a dynamic `await import`) pulls
        // Node built-ins (`node:fs`/`node:perf_hooks`, via the `env/server` +
        // `errorHandling` + `unfurl.js` import chain) into the client bundle and
        // breaks `next build`. `getUnreadMessagesForUser` is the same fn the
        // resolver runs, so the seed is byte-identical (`{ chatId, cnt }[]`, #2471
        // gotcha). Anon never fires this protected query, so seed authed-only; on
        // a chat-service error fall back to undefined and let the client self-heal
        // via `ChatButton`'s own live fetch.
        session?.user
          ? getUnreadMessagesForUser({ userId: session.user.id }).catch(() => undefined)
          : Promise.resolve(undefined),
        // SSR-seed the ambient, auth-gated `user.checkNotifications` query (the
        // header bell unread count, fires on every logged-in bootstrap). Uses
        // the SAME shared `getUserNotificationCounts` reduce the resolver uses,
        // so the seed is byte-identical to a live fetch (plain { all, <cat> }
        // object of numbers — no superjson Date/array divergence). Anon never
        // fires this query (protectedProcedure + `enabled: !!currentUser`), so
        // seed authed-only. `.catch(undefined)` so a redis/DB blip degrades to
        // no-seed (client self-heals on bootstrap) and can never reject the
        // Promise.all and drop the critical settings/session payload.
        session?.user
          ? getUserNotificationCounts({ userId: session.user.id }).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      res.status(200).json({
        settings,
        tosMeta,
        announcements,
        following,
        chatUnreadCount,
        notificationCounts,
        session: session?.user && Object.keys(session.user).length > 0 ? session : null,
      });
    } catch (e) {
      res.status(200).json({});
    }
  },
  ['GET']
);
