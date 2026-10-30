import type { NextApiRequest, NextApiResponse } from 'next';
import {
  encodeShellMainImageHeader,
  SHELL_MAIN_IMAGE_HEADER,
} from '~/components/Shell/shell-page-data';
import { logToAxiom } from '~/server/logging/client';
import {
  imageDetailMainImageUrlFor,
  startImageDetailPageData,
} from '~/server/page-data/image-detail';
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
import { syncShellRouteCookie } from '~/server/shell/shell-response';
import {
  dehydrateSsgState,
  getServerProxySSGHelpers,
  resolveAdsGated,
} from '~/server/utils/server-side-helpers';

/**
 * `GET /api/page-data/images/[imageId]` — everything a server render of `/images/[imageId]`
 * computes for ITS viewer, in one response: the settings bootstrap and the session, the feature
 * flags and their per-user overlay, chat settings, region, `adsGated`, and the page's `trpcState` —
 * plus, in the `SHELL_MAIN_IMAGE_HEADER` response header, the URL of the page's main image for
 * this viewer, for the shell to preload.
 * It is what the static (viewer-independent) shell of the page reads instead of being rendered
 * per viewer.
 *
 * EARLY HEADERS. The main image is decided from two reads (the image row and its contest rating),
 * which start, with the page's other prefetches, in parallel with the bootstrap seeds. As soon as
 * those two are in, the response's headers — main-image URL, route cookie, `private, no-store` —
 * are FLUSHED (`res.flushHeaders()`), so the shell's head script can start the image download
 * while the rest of the body is still being computed. The body follows once everything is done.
 * Before the flush every outcome can still be any status (404, 500); after it the status is a
 * 200 that can no longer change, so:
 *   - a 404 (flag off, non-numeric id) is decided before the flush, and never flushes;
 *   - a failure after the flush ENDS the response with no body: the shell's client reads a 200
 *     whose body is not page data (`readShellResponse`) as unusable and falls back to a full
 *     render — a half-written or error JSON body would be no different, but none is sent;
 *   - no header can be written after the flush, so the body goes out with `res.end`, not
 *     `res.json` (which sets headers).
 *
 * Built from the same pieces as the render: the page's resolver (`~/server/page-data/image-detail`),
 * the SSG helpers and dehydrate of `createServerSideProps`, and the bootstrap's request builder and
 * seeds (`settingsBootstrapRequest`, `resolveSettingsBootstrapSeeds`). Not shared, and pinned by tests
 * instead: `trpcState` equal to the page's for the same viewer, and the bootstrap request (`?token=`
 * ignored, the render's host for the seeds). The chat-settings and overlay seeds mirror `_app`'s by
 * hand.
 *
 * 🔴 The body is the viewer's own, so every answer — errors included — is `private, no-store`, set
 * first and again just before the headers go out (the flush, or a non-200's `send`), so a header a
 * procedure wrote on the way cannot survive. Deliberately NOT `PublicEndpoint`, which stamps
 * `public, s-maxage=300`.
 *
 * The session lookup gets the REAL response, and runs before anything else: it may roll the
 * session cookie on it, which is the point — a viewer of a shell page has no other request that
 * would — and that cookie is then set before the flush.
 *
 * Gated by the `shell-images` flag: 404 for anyone it is off for. Only the session lookup runs
 * first (the flag is per user); no bootstrap seed and no page data is read for them. It keeps the
 * route's `civ-shell-images` cookie in step with that flag (`~/server/shell/shell-response`).
 * Region blocking is the proxy's (`apiRegionBlockMiddleware`; `/api/page-data` is in its matcher).
 */

const CACHE_CONTROL = 'private, no-store';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', CACHE_CONTROL);
  /** A whole answer, headers and body at once — for every answer that is not the flushed 200. */
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
    // The route cookie follows the flag from here too: a viewer the flag went off for stops being
    // considered for the shell, and one it is on for keeps the cookie from expiring.
    if (!flags.shellImages) {
      syncShellRouteCookie(req, res, 'images', false);
      return send(404, { error: 'Not found' });
    }

    // Every prefetch of the page, started now (in `trpcState`'s order) — before the bootstrap
    // seeds, which nothing here needs to have been read first.
    const ssg = await getServerProxySSGHelpers({ req, res }, session, { ...flags });
    const pageData = startImageDetailPageData({
      ctx: { params: { imageId: req.query.imageId } },
      ssg,
      session,
    });
    if ('notFound' in pageData) return send(404, { error: 'Not found' });

    // The seeds, from the exact request a server render's bootstrap reads (the internal bootstrap
    // host), so the host-derived ones — ToS, announcements — are the page's. In parallel with the
    // page's prefetches. Awaited below; a failure that lands before the flush is a 500, and the
    // handler here only keeps it from being an unhandled rejection meanwhile.
    let bootstrapFailed = false;
    const bootstrapSeeds = resolveSettingsBootstrapSeeds(settingsBootstrapRequest(req), session);
    bootstrapSeeds.catch(() => {
      bootstrapFailed = true;
    });
    // Not awaited on the early-exit paths below (a 500 before the flush); never let it go unhandled.
    pageData.result.catch(() => undefined);

    const mainImage = await pageData.mainImage;
    if (bootstrapFailed) await bootstrapSeeds; // throws: still a 500, nothing flushed yet

    // The exact URL the page's main `<img>` will request for THIS viewer, or no header when it
    // will request none (video, gated, blur-dependent, hidden, a feed or storyline query). Here and
    // never in the cached shell HTML, which is the same for every viewer.
    const mainImageUrl = imageDetailMainImageUrlFor({
      query: req.query,
      mainImage,
      viewer: session?.user,
      canViewNsfw: !!flags.canViewNsfw,
    });
    if (mainImageUrl) {
      res.setHeader(SHELL_MAIN_IMAGE_HEADER, encodeShellMainImageHeader(mainImageUrl));
    }
    syncShellRouteCookie(req, res, 'images', !!session?.user, { refresh: true });
    res.setHeader('Content-Type', JSON_CONTENT_TYPE);
    // Again, last: a procedure may have written its own on the way here; after the flush nothing
    // can replace this one.
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.statusCode = 200;
    res.flushHeaders();

    const bootstrap = jsonRoundTrip(await bootstrapSeeds);
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

    const result = await pageData.result;

    // Named one by one, under the `pageProps` names `_app` gives them, so a field the bootstrap
    // gains later is not published here unreviewed. ONE write: the body is whole or absent.
    res.end(
      JSON.stringify({
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
      })
    );
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'page-data failed',
      route: '/images/[imageId]',
      // After the flush the client sees a 200 with no body; this is the only place that says so.
      afterFlush: res.headersSent,
      message: e instanceof Error ? e.message : String(e),
    }).catch(() => undefined);
    if (!res.headersSent) send(500, { error: 'Page data unavailable' });
    // Headers flushed as a 200: end it with NO body, which the shell's client cannot adopt and
    // falls back to a full render on — never an error JSON it would try to read as page data.
    else if (!res.writableEnded) res.end();
  }
}
