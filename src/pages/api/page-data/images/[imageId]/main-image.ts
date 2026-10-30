import type { NextApiRequest, NextApiResponse } from 'next';
import {
  encodeShellMainImageHeader,
  SHELL_MAIN_IMAGE_HEADER,
} from '~/components/Shell/shell-page-data';
import { logToAxiom } from '~/server/logging/client';
import { resolveImageDetailMainImageUrl } from '~/server/page-data/image-detail';
import { resolvePageDataSession } from '~/server/page-data/page-data-session';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { getServerProxySSGHelpers } from '~/server/utils/server-side-helpers';

/**
 * `GET /api/page-data/images/[imageId]/main-image` — the URL of the main image the page
 * `/images/[imageId]` renders for THIS viewer, in the `SHELL_MAIN_IMAGE_HEADER` response header of
 * a `204` (no header: the page requests no image to preload). The static shell's inline head script
 * requests it in parallel with the page data (`shellPageDataPrefetchScript`) and preloads the URL,
 * so the image downloads while the page data is still being computed.
 *
 * Its own request, not a header on the page data: a header there arrives with that response's
 * body, after all of its work (the bootstrap seeds, every prefetch, the dehydrate) — too late to
 * start the image any earlier than the page would.
 *
 * It does only what the URL needs: the session (read-only: the page data rolls the cookie), the
 * flags, and — unless the query alone rules a preload out — the image row and its contest rating,
 * through the page's own procedures (`resolveImageDetailMainImageUrl`), so the access decisions are
 * `image.get`'s and the URL is the one the page's `<img>` requests.
 *
 * Status: `204` with or without the header, a body would carry nothing the header does not; `404`
 * where the page data is one (flag off, non-numeric id); `405`; `500` on a failure. Only a `204`
 * ever carries the header.
 *
 * 🔴 The answer is the viewer's own (it reveals whether they may see the image), so every answer —
 * errors included — is `private, no-store`, set first and again just before the answer goes out,
 * so a header a procedure wrote on the way cannot survive.
 *
 * Gated by the `shell-images` flag like the page data: 404 for anyone it is off for, with no image
 * read. It leaves the route cookie to the page data (`syncShellRouteCookie`). Region blocking is the
 * proxy's (`apiRegionBlockMiddleware`; `/api/page-data` is in its matcher).
 */

const CACHE_CONTROL = 'private, no-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', CACHE_CONTROL);
  const send = (status: number, url?: string) => {
    res.setHeader('Cache-Control', CACHE_CONTROL);
    if (url) res.setHeader(SHELL_MAIN_IMAGE_HEADER, encodeShellMainImageHeader(url));
    else res.removeHeader(SHELL_MAIN_IMAGE_HEADER);
    res.status(status).end();
  };

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(405);
  }

  try {
    const session = await resolvePageDataSession(req, 'read-only');
    // The page data's evaluation, so the two agree on the gate and on `canViewNsfw`.
    const flags = await getFeatureFlagsAsync({ user: session?.user, req });
    if (!flags.shellImages) return send(404);

    const result = await resolveImageDetailMainImageUrl({
      query: req.query,
      ssg: () => getServerProxySSGHelpers({ req, res }, session, { ...flags }),
      session,
      canViewNsfw: !!flags.canViewNsfw,
    });
    if ('notFound' in result) return send(404);
    return send(204, result.url);
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'page-data main image failed',
      route: '/images/[imageId]',
      message: e instanceof Error ? e.message : String(e),
    }).catch(() => undefined);
    if (!res.headersSent) send(500);
  }
}
