import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';
import {
  COVER_LISTING_UNREADABLE,
  COVER_NO_LISTING,
  attachCoverImage,
  readCoverListing,
  type CoverListing,
} from '@civitai/app-assistant';
import { logToAxiom, safeError } from '~/server/logging/client';
import {
  RUNNER_COVER_APP_MAX,
  coverRefusalMessage,
  openRunnerCover,
} from '~/server/services/app-assistant/runner-cover';

/**
 * POST /api/internal/app-assistant/cover/attach
 *
 * App Assistant's server runner puts the cover its `generate_app_cover` generated (on the user's
 * Buzz, with the user's own chat token) on the user's listing, as the page does: the image is
 * ingested as a cover upload and scanned like an author's (`appListings.ingestAssetFromUrl`), then
 * attached by `appListings.setCover` with its checks on size, type and scan state, both called as
 * the user its run grant names.
 *
 * The listing is the user's OWN listing for `app`, looked up again here (`getMyListingForApp`, which
 * has no moderator override): `listingId` must be that listing's, or nothing is attached. So the
 * runner can never name another listing, whoever the user is (`setCover` alone lets a moderator
 * reach any listing).
 *
 * Called only by the runner, with `Authorization: Bearer <ASSISTANT_RUNNER_SECRET>`. Body:
 *   { grant, app, listingId, url }   `listingId` as `cover/listing` answered it; `url` the image
 *
 * Re-judged on every call (`openRunnerCover`), as `cover/listing`.
 *
 *   200 `{ scanPending }` attached; `scanPending` the image is still being checked
 *   400 `{ error }` the body is not that shape
 *   401 the runner's secret is missing or wrong; `invalid_grant` not a current run grant
 *   403 `refused` / `FORBIDDEN` as `cover/listing`
 *   404 `NOT_FOUND` `listingId` is not the user's listing for `app` (or they have none)
 *   409 `CONFLICT` the listing's media cannot be edited now; `error` says why, for the user
 *   422 `not_attached` civitai refused the image; `error` says why, for the user
 *   503 `unavailable` the gates or the listing could not be read just now
 */
const body = z.object({
  grant: z.string().min(1).max(4096),
  app: z.string().min(1).max(RUNNER_COVER_APP_MAX),
  listingId: z.string().min(1).max(200),
  url: z.url().max(4096),
});

export default withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
  const opened = await openRunnerCover(req, res, body, 'Expected { grant, app, listingId, url }');
  if (!opened) return;
  const { grant, api } = opened;
  const { app, listingId, url } = opened.body;
  const log = (type: string, extra: Record<string, unknown> = {}) =>
    logToAxiom({
      type: `app-assistant.runner-cover.${type}`,
      message: `App Assistant runner cover ${type} for user ${grant.userId}`,
      userId: grant.userId,
      grantId: grant.grantId,
      listingId,
      ...extra,
    }).catch(() => undefined);

  let listing: CoverListing | null;
  try {
    listing = await readCoverListing(api, app);
  } catch (err) {
    log('listing-failed', { error: safeError(err) });
    return res.status(503).json({ error: COVER_LISTING_UNREADABLE, code: 'unavailable' });
  }
  if (!listing || listing.listingId !== listingId) {
    log('refused', { reason: 'not-own-listing' });
    return res.status(404).json({ error: COVER_NO_LISTING, code: 'NOT_FOUND' });
  }
  if (listing.blockedReason)
    return res.status(409).json({ error: listing.blockedReason, code: 'CONFLICT' });

  try {
    const { scanPending } = await attachCoverImage(api, listing.listingId, url);
    log('attached', { scanPending });
    return res.json({ scanPending });
  } catch (err) {
    log('not-attached', { error: safeError(err) });
    return res.status(422).json({ error: coverRefusalMessage(err), code: 'not_attached' });
  }
});
