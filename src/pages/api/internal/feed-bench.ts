import type { NextApiRequest, NextApiResponse } from 'next';
import { serveImagesAsPostsStandalone } from '~/server/feed-bench/images-as-posts-standalone';

/**
 * Not a route: the way the image feed benchmark's standalone server
 * (`scripts/feed-bench/server.cjs`, shipped in the image as `feed-bench/server.cjs`) reaches the
 * compiled application code. Next compiles every page into `.next/server`; that server loads THIS
 * page's compiled module and calls `serveImagesAsPostsStandalone`, carried on the default export,
 * so the standalone arm runs the exact modules (same build, same module instances) the tRPC route
 * runs, without Next's request handling and without tRPC. See scripts/feed-bench/README.md.
 *
 * Under Next every request here is a 404, whatever its method or credentials: nothing is served.
 */
function notFound(_req: NextApiRequest, res: NextApiResponse) {
  res.status(404).end();
}

export default Object.assign(notFound, { serveImagesAsPostsStandalone });
