import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';
import { COVER_LISTING_UNREADABLE, readCoverListing } from '@civitai/app-assistant';
import { logToAxiom, safeError } from '~/server/logging/client';
import {
  RUNNER_COVER_APP_MAX,
  openRunnerCover,
} from '~/server/services/app-assistant/runner-cover';

/**
 * POST /api/internal/app-assistant/cover/listing
 *
 * App Assistant's server runner reads, for the user its run grant names, their own store listing for
 * an app, before its `generate_app_cover` offers a cover: the same read the page makes
 * (`appListings.getMyListingForApp`, called as the user), so an app with no listing, or someone
 * else's, answers none and nothing is offered.
 *
 * Called only by the runner, with `Authorization: Bearer <ASSISTANT_RUNNER_SECRET>`. Body:
 *   { grant, app }   `app` the open app's key (its listing's slug)
 *
 * 200 `{ listing: { listingId, blockedReason, status } | null }` (null: no listing of theirs).
 * Every refusal is `openRunnerCover`'s (secret, method, body, grant, user gates), or 503 `unavailable`.
 */
const body = z.object({
  grant: z.string().min(1).max(4096),
  app: z.string().min(1).max(RUNNER_COVER_APP_MAX),
});

export default withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
  const opened = await openRunnerCover(req, res, body, 'Expected { grant, app }');
  if (!opened) return;
  const { grant, api } = opened;
  try {
    const listing = await readCoverListing(api, opened.body.app);
    return res.json({ listing });
  } catch (err) {
    logToAxiom({
      type: 'app-assistant.runner-cover.listing-failed',
      message: `App Assistant runner cover listing read failed for user ${grant.userId}`,
      userId: grant.userId,
      grantId: grant.grantId,
      error: safeError(err),
    }).catch(() => undefined);
    return res.status(503).json({ error: COVER_LISTING_UNREADABLE, code: 'unavailable' });
  }
});
