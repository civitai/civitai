import { isDev } from '~/env/other';
import { Tracker } from '~/server/clickhouse/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getMatchingPathname } from '~/shared/constants/pathname.constants';

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
