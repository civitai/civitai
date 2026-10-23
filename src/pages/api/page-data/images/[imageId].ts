import type { NextApiRequest, NextApiResponse } from 'next';
import { logToAxiom } from '~/server/logging/client';
import { resolveImageDetailPageData } from '~/server/page-data/image-detail';
import { resolveChatSettings } from '~/server/schema/chat.schema';
import type { UserSettingsChat } from '~/server/schema/chat.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import {
  computeUserFeatureFlagsOverlay,
  getFeatureFlagsAsync,
  getFliptGatedEligibility,
} from '~/server/services/feature-flags.service';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import {
  bootstrapSession,
  resolveSettingsBootstrapSeeds,
  settingsBootstrapRequest,
} from '~/server/services/settings-bootstrap.service';
import { getRegion } from '~/server/utils/region-blocking';
import {
  dehydrateSsgState,
  getServerProxySSGHelpers,
  resolveAdsGated,
} from '~/server/utils/server-side-helpers';

/**
 * `GET /api/page-data/images/[imageId]` — everything a server render of `/images/[imageId]`
 * computes for ITS viewer, in one response: the settings bootstrap and the session, the feature
 * flags and their per-user overlay, chat settings, region, `adsGated`, and the page's `trpcState`.
 * It is what a static (viewer-independent) shell of the page will read instead of being rendered
 * per viewer. Nothing calls it yet.
 *
 * Built from the same pieces as the render: the page's resolver (`~/server/page-data/image-detail`),
 * the SSG helpers and dehydrate of `createServerSideProps`, and the bootstrap's request builder and
 * seeds (`settingsBootstrapRequest`, `resolveSettingsBootstrapSeeds`). Not shared, and pinned by tests
 * instead: `trpcState` equal to the page's for the same viewer, and the bootstrap request (`?token=`
 * ignored, the render's host for the seeds). The chat-settings and overlay seeds mirror `_app`'s by
 * hand.
 *
 * 🔴 The body is the viewer's own, so every answer — errors included — is `private, no-store`, set
 * first and again just before the body goes out, so a header a procedure wrote on the way cannot
 * survive. Deliberately NOT `PublicEndpoint`, which stamps `public, s-maxage=300`.
 *
 * The session lookup gets the REAL response: it may roll the session cookie on it, which is the
 * point — a viewer of a shell page has no other request that would.
 *
 * Gated by the `shell-images` flag: 404 for anyone it is off for. Only the session lookup runs
 * first (the flag is per user); no bootstrap seed and no page data is read for them.
 * Region blocking is the proxy's (`apiRegionBlockMiddleware`; `/api/page-data` is in its matcher).
 */

const CACHE_CONTROL = 'private, no-store';

const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', CACHE_CONTROL);
  const send = (status: number, body: unknown) => {
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.status(status).json(body);
  };

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(405, { error: 'Method not allowed' });
  }

  try {
    // The session, from the request a server render's bootstrap reads (fixed path, so a `?token=`
    // here never replaces the cookie viewer), with two differences: the REAL response, so the
    // session cookie can roll, and the viewer's own host, which that cookie's Domain comes from.
    // The credential the lookup records goes on THIS request's context, where the tRPC context
    // below reads it.
    const sessionRequest = settingsBootstrapRequest(req, {
      host: req.headers.host,
      context: ((req as { context?: Record<string, unknown> }).context ??= {}),
    });
    // JSON round-tripped exactly as a server render's bootstrap is
    // (`resolveSettingsBootstrapForRender`), so the session the procedures below see is the one
    // `_app` seeds a render's `req.session` with — dates as ISO strings, not `Date`s.
    const session = jsonRoundTrip(
      bootstrapSession(await getServerAuthSession({ req: sessionRequest, res }))
    );

    // The same evaluation as both `_app` (which passes the request's own host) and
    // `createServerSideProps`. Decided before the rest of the bootstrap is read.
    const flags = await getFeatureFlagsAsync({ user: session?.user, req });
    if (!flags.shellImages) return send(404, { error: 'Not found' });

    // The seeds, from the exact request a server render's bootstrap reads (the internal bootstrap
    // host), so the host-derived ones — ToS, announcements — are the page's.
    const bootstrap = jsonRoundTrip(
      await resolveSettingsBootstrapSeeds(settingsBootstrapRequest(req), session)
    );
    const { settings } = bootstrap;

    let userFeatureFlags: FeatureAccess | undefined;
    let chatSettings: UserSettingsChat | undefined;
    if (session?.user && settings) {
      userFeatureFlags = computeUserFeatureFlagsOverlay(
        settings.features,
        flags,
        getFliptGatedEligibility({ user: session.user, host: req.headers.host, req })
      );
      chatSettings = resolveChatSettings(settings.chat);
    }

    const ssg = await getServerProxySSGHelpers({ req, res }, session, { ...flags });
    const result = await resolveImageDetailPageData({
      ctx: { params: { imageId: req.query.imageId } },
      ssg,
      session,
    });
    if ('notFound' in result) return send(404, { error: 'Not found' });

    // Named one by one, under the `pageProps` names `_app` gives them, so a field the bootstrap
    // gains later is not published here unreviewed.
    return send(200, {
      session,
      settings,
      tosMeta: bootstrap.tosMeta,
      announcements: bootstrap.announcements,
      following: bootstrap.following,
      browsingSettingsAddons: bootstrap.browsingSettingsAddons,
      liveNow: bootstrap.liveNow,
      navBanners: bootstrap.navBanners,
      siteAlerts: bootstrap.siteAlerts,
      flags,
      userFeatureFlags,
      chatSettings,
      region: getRegion(req),
      adsGated: resolveAdsGated(result, flags),
      trpcState: dehydrateSsgState(ssg, req.url),
    });
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'page-data failed',
      route: '/images/[imageId]',
      message: e instanceof Error ? e.message : String(e),
    }).catch(() => undefined);
    if (!res.headersSent) send(500, { error: 'Page data unavailable' });
  }
}
