import { isDev } from '~/env/other';
import { Tracker } from '~/server/clickhouse/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getMatchingPathname } from '~/shared/constants/pathname.constants';

// Page-view beacon. Deliberately named generically (NOT "page-view"/"track"):
// ad/privacy blockers (EasyPrivacy, uBlock) match those keywords in the request
// path and cancel the request client-side with ERR_BLOCKED_BY_CLIENT before it
// ever reaches the origin — silently dropping a large share of page views. The
// client caller lives in src/components/TrackView/TrackPageView.tsx.
export default PublicEndpoint(
  async (req, res) => {
    if (isDev) return res.status(200).end();

    // A malformed-but-present `referer` (bot/scraper traffic) makes `new URL()`
    // throw a TypeError. That's invalid client input, not a server fault → 400,
    // matching the host-mismatch case below (was an unguarded raw 500).
    let url: URL | undefined;
    try {
      url = req.headers.referer ? new URL(req.headers.referer) : undefined;
    } catch {
      return res.status(400).send('invalid request');
    }
    const host = req.headers.host;

    if (!url || url.host !== host) return res.status(400).send('invalid request');

    // This client (src/components/TrackView/TrackPageView.tsx) sends no
    // Content-Type, so Next leaves `req.body` a raw string and JSON.parse is
    // correct — but a malformed/empty body throws SyntaxError. Invalid input →
    // 400 (was an unguarded raw 500). NOTE: only the parse is guarded; a genuine
    // failure in the tracker.pageView path below still surfaces normally.
    let body: { ads?: boolean; duration: number; path: string; windowWidth?: number; windowHeight?: number };
    try {
      body = JSON.parse(req.body);
    } catch {
      return res.status(400).send('invalid request');
    }
    const { ads, duration, path, windowWidth, windowHeight } = body;
    const country = (req.headers['cf-ipcountry'] as string) ?? 'undefined';

    const match = getMatchingPathname(path);
    if (!match) return res.status(200).end();

    const tracker = new Tracker(req, res);
    await tracker.pageView({
      pageId: match,
      path,
      host,
      country,
      ads: ads ?? false,
      duration: Math.floor(duration),
      windowWidth,
      windowHeight,
    });

    return res.status(200).end();
  },
  ['POST']
);
