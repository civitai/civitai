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
import { resolveSettingsBootstrap } from '~/server/services/settings-bootstrap.service';
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
 * Built from the same pieces as the render, so the two cannot drift: the page's resolver
 * (`~/server/page-data/image-detail`), the SSG helpers and dehydrate of `createServerSideProps`,
 * and the seeds `_app.getInitialProps` derives from the bootstrap. The parity test pins that the
 * `trpcState` here equals the page's for the same viewer.
 *
 * 🔴 The body is the viewer's own, so every answer — errors included — is `private, no-store`, set
 * first and again just before the body goes out, so a header a procedure wrote on the way cannot
 * survive. Deliberately NOT `PublicEndpoint`, which stamps `public, s-maxage=300`.
 *
 * The bootstrap gets the REAL response: the session lookup may roll the session cookie on it,
 * which is the point — a viewer of a shell page has no other request that would.
 *
 * Gated by the `shell-images` flag: 404 for anyone it is off for, before any page data is read.
 * Region blocking is the proxy's (`apiRegionBlockMiddleware`; `/api/page-data` is in its matcher).
 */

const CACHE_CONTROL = 'private, no-store';

type Bootstrap = Awaited<ReturnType<typeof resolveSettingsBootstrap>>;

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
    // JSON round-tripped exactly as a server render's bootstrap is
    // (`resolveSettingsBootstrapForRender`), so the session the procedures below see is the one
    // `_app` seeds a render's `req.session` with — dates as ISO strings, not `Date`s.
    const bootstrap = JSON.parse(
      JSON.stringify(await resolveSettingsBootstrap({ req, res }))
    ) as Bootstrap;
    const { session, settings } = bootstrap;

    // The same evaluation as both `_app` (which passes the request's own host) and
    // `createServerSideProps`.
    const flags = await getFeatureFlagsAsync({ user: session?.user, req });
    if (!flags.shellImages) return send(404, { error: 'Not found' });

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
