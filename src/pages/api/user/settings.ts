import { getUserContentSettings } from '~/server/services/user.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { checkTosUpdate } from '~/server/services/content.service';
import { getCurrentAnnouncements } from '~/server/services/announcement.service';
import { getRequestDomainColor } from '~/server/utils/server-domain';

export default PublicEndpoint(
  async function handler(req, res) {
    try {
      const session = await getServerAuthSession({ req, res });
      // Use the content-settings view so SSR initialData matches the tRPC
      // getSettings response shape (JSON settings + User-column toggles).
      const settings = await getUserContentSettings(session?.user?.id ?? -1);
      // Compute the `content.checkTosUpdate` result here (server-only API route)
      // so `_app` getInitialProps can SSR-seed that query WITHOUT importing
      // `content.service` — which pulls `fs/promises` into `_app`'s client-bundled
      // graph and breaks the build. Domain fallback matches createContext's
      // `getRequestDomainColor(req) ?? 'blue'` so the seed stays byte-identical to
      // a live `checkTosUpdate` fetch.
      const tosUpdate = session?.user
        ? await checkTosUpdate({
            domainColor: getRequestDomainColor(req) ?? 'blue',
            userSettings: settings,
          })
        : undefined;
      // SSR-seed the ambient `announcement.getAnnouncements` query (fires on every
      // bootstrap, anon + authed). Computed here — NOT in `_app` getInitialProps —
      // because `announcement.service` is server-only and importing it into `_app`
      // leaks it into the client bundle. Match the resolver byte-for-byte: its
      // `applyRequestDomainColor` middleware overrides the client input with
      // `getRequestDomainColor(req)` (NO 'blue' fallback), so we pass the same raw
      // value here. Defensive: an announcements failure must not drop the critical
      // settings/session payload — fall back to undefined and let the client
      // self-heal via a live fetch.
      let announcements: Awaited<ReturnType<typeof getCurrentAnnouncements>> | undefined;
      try {
        announcements = await getCurrentAnnouncements({
          domain: getRequestDomainColor(req),
          userId: session?.user?.id,
        });
      } catch {
        announcements = undefined;
      }
      res.status(200).json({
        settings,
        tosUpdate,
        announcements,
        session: session?.user && Object.keys(session.user).length > 0 ? session : null,
      });
    } catch (e) {
      res.status(200).json({});
    }
  },
  ['GET']
);
