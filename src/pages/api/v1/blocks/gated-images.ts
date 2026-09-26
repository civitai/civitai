import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { resolveGatedImagesForBlockClaims } from '~/server/services/blocks/block-gated-images-read.service';
import { checkBlockCatalogRateLimit } from '~/server/utils/block-catalog-rate-limit';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import { IMAGE_IDS_BATCH_MAX } from '~/server/common/constants';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

/**
 * GET /api/v1/blocks/gated-images?ids=1,2,3 → `{ images: BlockGatedImage[] }`
 * Any valid block token; no required scope.
 *
 * The per-viewer GATED image read — the REST twin of the `GET_IMAGES_BY_IDS` →
 * `IMAGES_RESULT` bridge message, for apps porting off the postMessage bridge
 * onto `@civitai/sdk`. Given the image ids an app stored (a benchmark grid, a
 * generator's cover image, a gallery panel), it answers, PER REQUESTING VIEWER,
 * which of them that viewer may actually be shown — and returns a host-minted,
 * moderated edge url for exactly those.
 *
 * A thin adapter over `resolveGatedImagesForBlockClaims`, the SAME function
 * `blocks.getImagesByIds` calls, so the anon refusal, the App-Blocks kill-switch
 * against the TOKEN SUBJECT, the `maxBrowsingLevel` maturity clamp and the
 * app-scoped read all hold verbatim and none of them is re-spelled here. See that
 * module's docblock for where the transport seam is and why the rate limiter sits
 * on this side of it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THIS ROUTE EXISTS WHEN `/api/v1/blocks/images?ids=` ALREADY DOES, AND
 * WHY THAT ROUTE CANNOT BE USED INSTEAD. READ THIS BEFORE PROPOSING A MERGE.
 *
 * 🔴 THE DECISIVE FACT IS THAT THE TWO CORPORA ARE DISJOINT — not that the two
 * routes DISCLOSE differently. `blocks/images` serves `runImageSearch`
 * (`src/pages/api/v1/blocks/images.ts:218`) over the Meilisearch images index,
 * whose source query hard-filters `i."postId" IS NOT NULL`
 * (`src/server/search-index/images.search-index.ts:134`, and again at `:282` for
 * the incremental update pass). THIS route's corpus is exactly the complement —
 * `AND i."postId" IS NULL` (`block-gated-images.service.ts:184`), further scoped
 * to `blockPublishedAppId = claims.appId`. Complementary predicates: an image
 * cannot satisfy both. So `blocks/images?ids=` returns an EMPTY ARRAY for every
 * id in this route's corpus — at any ceiling, for any viewer, forever. "Use
 * `blocks/images` and accept losing the hidden tile" is therefore not a trade:
 * there is no hidden tile, and no visible one either. Everything below is why the
 * two routes ANSWER differently; THIS is why one cannot substitute for the other
 * at all.
 *
 * `blocks/images` is a catalog SEARCH route sharing `runImageSearch` with the
 * public `/api/v1/images`. Its `?ids=` selector is a FILTER over that search, and
 * an id the viewer's ceiling excludes is reported BY OMISSION — its own docblock:
 * *"Misses are reported by OMISSION — the same deliberate non-disclosure."*
 *
 * Omission is right THERE and wrong HERE, and the difference is the CORPUS, not
 * the wire format:
 *
 *   • `blocks/images` reads the WHOLE PUBLIC CATALOG. On that corpus, saying "id
 *     12345 exists but is withheld from you" is itself the disclosure: a
 *     SFW-domain block could walk the id space and enumerate the site's mature
 *     catalog without ever receiving a pixel. Collapsing "above your ceiling"
 *     into "not in your results" is what stops that, and nothing here changes it.
 *
 *   • THIS route reads only rows carrying `metadata.blockPublishedAppId =` THIS
 *     TOKEN'S OWN `appId`, with `postId IS NULL` — images the CALLING APP ITSELF
 *     published, through its own workflow, on behalf of its own users. The app
 *     already holds those ids; it is the party that stored them. "This id exists"
 *     is the caller's own record being read back, not a fact about the catalog,
 *     so there is no id space to enumerate and no oracle to build.
 *
 * So the two doctrines are not in tension — they partition, and the bridge has
 * always drawn the line in exactly this place:
 *
 *   OMISSION covers every case where EXISTENCE would be the disclosed bit — the
 *   id is not this app's, does not exist, or belongs to a user/tag this viewer
 *   has blocked. Those ids simply are not in the response array.
 *
 *   HONEST BOUND ON THAT ABSOLUTE: because the viewer's blocked-users and
 *   blocked-tags sets are excluded AT THE QUERY LEVEL rather than classified,
 *   omission of an id the app KNOWS is its own means "deleted" OR "this viewer
 *   blocked the author or one of its tags" — so an app publishing on behalf of
 *   many users can probe viewer B's block list. Pre-existing and inherited
 *   verbatim from the bridge — `block-gated-images.{logic,service}.ts` are
 *   UNCHANGED by the PR that added this route (byte-identical to its merge base
 *   and to `main` at the time of writing), so this route introduces no new bit.
 *
 *   `status: 'hidden'` covers the case where the caller already knows the row
 *   exists because it published it, and the only open question is whether THIS
 *   viewer may see the pixels. It carries NO url, ever.
 *
 * 🔴 AND THE NON-DISCLOSURE PROPERTY INSIDE `hidden` IS PRESERVED BY THE SERVICE,
 * NOT BY THE TRANSPORT. `classifyGatedImageForViewer` draws a third verdict —
 * `pending`, meaning nothing has rated this image yet — and
 * `getBlockGatedImagesByIds` deliberately COLLAPSES it into `hidden` for every
 * viewer who is not the image's own author. That is what stops `hidden` from
 * becoming a positive assertion that "a rating exists and it is above your
 * ceiling", which would let a SFW viewer enumerate which cells of someone else's
 * grid are mature-or-flagged. This route inherits that by calling the same body;
 * it adds no status and widens no disclosure over the bridge.
 *
 * 🔴 WHY THE DISCRIMINATOR IS LOAD-BEARING FOR CONSUMERS, i.e. why omission is a
 * real regression rather than a cosmetic one. With omission, a HIDDEN image and a
 * DELETED image are the same observation, so an app cannot tell "we are
 * withholding this from you" from "this is gone". Three fleet apps branch on the
 * difference today: `civitai-app-model-benchmarking`'s `GatedCell` renders a
 * *"Hidden — rated mature"* tile with a settings hint on `status === 'hidden'`
 * and would render nothing at all under omission; `civitai-app-gen-matrix` feeds
 * the per-image level to `MaturityImage`'s fail-closed blur; and
 * `civitai-app-custom-generators` treats this read as *"the ONLY sanctioned
 * source of a cover url"*, mapping anything not `visible` to `null` so a card can
 * never fall back to the unmoderated stored url.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 🔴 AN ANONYMOUS VIEWER GETS 401, NOT AN EMPTY LIST — parity with the bridge,
 * which has always refused the anon subject here. The full argument, and the open
 * question it leaves (the same one civitai#5089 asks of `/app-storage/*`), is at
 * `resolveGatedImagesForBlockClaims`. Stated here too because a route's anon
 * behaviour is what a consumer reads first: a signed-out viewer browsing a public
 * board currently resolves NO cover images, on either transport.
 *
 * WHY GET WITH THE IDS IN THE QUERY STRING, where `/app-storage/*` and
 * `/workflows/*` deliberately use POST bodies. Those two carry values that are
 * private to one viewer — a storage key an app names after its contents, a
 * workflow id that EMBEDS the viewer's user id — so putting them in a URL would
 * publish them to access logs and `Referer` headers. An image id is neither: it
 * is a public identifier the app already stored and already sends to
 * `/api/v1/blocks/images?ids=` in exactly this spelling. Keeping the two
 * by-id reads shaped identically is what lets a consumer move between them, and
 * `normalizeEndpoint` strips the query string, so the audit `endpoint` column
 * stays the fixed literal `/api/v1/blocks/gated-images` either way.
 *
 * NO `requiredScope`: any valid block token, the same mode `blocks/images` and
 * `blocks/models` use. Nothing here is reachable without the token's own signed
 * `maxBrowsingLevel` + `appId` claims, and those ARE the authorization — a scope
 * would add CLI-validator and per-app `allowedScopes` friction with no security
 * value over a read that is already narrowed to the app's own rows and the
 * viewer's own ceiling.
 *
 * NO `onApprovalLookupFailure: 'serve'`, DELIBERATELY. This is a viewer-scoped
 * read, not public catalog data, so it takes the fail-closed default: if the
 * backing `app_blocks` row cannot be resolved the request is refused rather than
 * served. `blocks/images` opts into `'serve'` precisely because it is public,
 * maturity-clamped catalog data; that argument does not transfer here.
 *
 * Response: `{ images }` — `BlockGatedImage[]`, byte-identical to the
 * `IMAGES_RESULT` bridge payload, in REQUEST order, with unresolvable ids
 * omitted. Ids are de-duplicated and capped by the shared body.
 */

// A query-string read: no request body is expected, and none is parsed.
const querySchema = z.object({
  // `?ids=1,2,3`. Bound by `IMAGE_IDS_BATCH_MAX` — the SAME ceiling
  // `GET_IMAGES_BY_IDS` enforces, held equal to the bridge procedure's own inline
  // `.max(100)` by `image-ids-batch-cap-parity.test.ts` so this route can never
  // drift into accepting a batch the bridge would have refused.
  ids: commaDelimitedNumberArray(
    z.number().int().positive().array().min(1).max(IMAGE_IDS_BATCH_MAX)
  ),
});

// Exported for unit testing (the default export is wrapped in withBlockScope,
// whose JWT gate would otherwise have to be satisfied to reach this handler).
export const baseHandler = withAxiom(async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    // withBlockScope only invokes this handler with a valid block JWT; this is
    // defense in depth.
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
    return;
  }

  // RATE LIMIT — the CATALOG bucket, weight 1, keyed on the stable
  // `blockInstanceId`, and the SAME bucket the bridge procedure charges, so
  // moving an app from the bridge to REST does not hand it a second allowance.
  // Fail-open on a Redis incident, like every sibling. Runs before the read, and
  // it lives at the transport rather than in the shared body so this half can
  // answer with `Retry-After` (mirrors `blocks/images`); see the seam note in
  // `block-gated-images-read.service.ts`.
  const rate = await checkBlockCatalogRateLimit(claims.blockInstanceId);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return;
  }

  try {
    const result = await resolveGatedImagesForBlockClaims({
      claims,
      imageIds: parsed.data.ids,
    });
    res.status(200).json(result);
    return;
  } catch (error) {
    // `handleEndpointError`, so failures answer `{ message }` and this route
    // stays off the known-leak list in `rest-error-envelope-ledger.test.ts`.
    return handleEndpointError(res, error);
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'gated_images',
  allowOpaqueOrigin: true,
});
