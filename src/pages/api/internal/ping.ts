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
    const url = req.headers.referer ? new URL(req.headers.referer) : undefined;
    const host = req.headers.host;

    if (!url || url.host !== host) return res.status(400).send('invalid request');

    const { ads, duration, path, windowWidth, windowHeight } = JSON.parse(req.body);
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
