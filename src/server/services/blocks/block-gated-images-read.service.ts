import { TRPCError } from '@trpc/server';

import {
  parseSubjectUserId,
  type BlockTokenClaims,
} from '~/server/middleware/block-scope.middleware';
import { assertAppBlocksEnabledForTokenUser } from '~/server/services/blocks/block-token-access.service';
import type { BlockGatedImage } from '~/server/services/blocks/block-gated-images.service';

/**
 * THE PER-VIEWER GATED IMAGE READ, from a VERIFIED block token's claims down to
 * the wire projection — extracted so the postMessage bridge
 * (`blocks.getImagesByIds` → `GET_IMAGES_BY_IDS`) and the REST twin
 * (`GET /api/v1/blocks/gated-images`) run ONE body rather than two spellings of
 * one security decision.
 *
 * WHY AN EXTRACTED FUNCTION AND NOT A tRPC CALLER — the split the repo already
 * made twice. `block-workflow-rest.ts` delegates to the four workflow PROCEDURES
 * because `submitWorkflow` alone is ~1100 lines of money path that reads `ctx`,
 * and moving it would be a 2,000-line diff on the highest-blast-radius resolver
 * in the repo. The shared-storage pair (#5054 / #5055) went the other way — short
 * bodies, no `ctx`, reviewable line by line. This one is firmly in the second
 * camp: the whole decision is the four steps below, it reads no `ctx`, and the
 * viewer binding already comes from `parseSubjectUserId` off the VERIFIED token
 * rather than from ambient request state.
 *
 * 🔴 WHERE THE SEAM IS, AND WHY IT IS *HERE* RATHER THAN AT THE RAW TOKEN. This
 * function takes already-VERIFIED claims, not a token string, so token
 * acquisition stays at each transport:
 *   - the bridge procedure calls `authorizeBlockBridgeToken` (signature, iss/aud/
 *     exp, per-instance revocation, the backing `app_blocks` row still saying
 *     `approved`);
 *   - the REST route is wrapped in `withBlockScope`, which resolves the SAME
 *     three properties through the same primitives before the handler runs —
 *     and `no-unguarded-block-rest-token.test.ts` positively FORBIDS a page route
 *     from verifying a block token itself, so a raw-token seam could not be used
 *     there even if it were desirable.
 * Two further consequences, stated because they look like duplication:
 *   - the catalog rate limiter is also spelled at each transport. It is a COST
 *     ceiling that fails OPEN, not an authority control (see the note in
 *     `no-unlimited-block-bridge-proc.test.ts`), and the REST half needs a
 *     `Retry-After` header that has no meaning on a tRPC mutation.
 *   - both bridge guards (`no-unguarded-block-bridge-token`,
 *     `no-unlimited-block-bridge-proc`) compute reachability by walking
 *     `blocks.router.ts`'s own AST one helper level deep, so a verify or a
 *     limiter that left the router would read as ABSENT there. That is
 *     fail-closed on purpose, and widening those guards to chase imports is not
 *     something a transport PR gets to do.
 * Everything that decides WHAT A VIEWER MAY SEE is below this line and has
 * exactly one copy.
 *
 * ORDER — the bridge procedure's order verbatim, moved rather than re-derived:
 *   1. SUBJECT — an anon subject is refused (see the anon note below).
 *   2. `assertAppBlocksEnabledForTokenUser` — the App-Blocks kill-switch,
 *      evaluated against the TOKEN SUBJECT.
 *
 *      🔴 NOT `enforceAppBlocksFlag`. That middleware evaluates the flag against
 *      `ctx.user`, the request's SESSION user, which is `undefined` on every
 *      block-token transport — so it resolves `false` and kills the surface
 *      outright. The four workflow procedures dropped it for exactly this reason
 *      (blocks.router.ts:3857, 4178, 5241, 5568) and civitai#5087 records it. The
 *      identity that owns this read is the token subject; that is the one the
 *      kill-switch has to bind. It is also NOT the AUTHOR gate
 *      (`assertViewerIsAppDeveloper`): a viewer of the app may read images the
 *      app published, or the grid renders for developers only.
 *   3. `resolveViewerBrowsingLevel` — 🔴 THE MATURITY CLAMP, AND IT IS NOT
 *      RE-DERIVED HERE. It reads the token's server-minted `maxBrowsingLevel`
 *      claim (the platform-computed viewer+domain ceiling), clamps it to
 *      selectable levels and FAILS CLOSED to the public (PG) floor. No request
 *      field reaches it on either transport — there is no maturity knob on the
 *      bridge input or the REST query string — so a block cannot widen its own
 *      ceiling by asking. Both transports get the identical number because they
 *      reach this identical line with the identical claim.
 *   4. `getBlockGatedImagesByIds` — the app-scoped read (`blockPublishedAppId` =
 *      this token's `appId`, `postId IS NULL`) plus the per-row projection.
 *
 * 🔴 AN ANONYMOUS VIEWER GETS `UNAUTHORIZED` (401 over REST), AND THAT IS PARITY
 * WITH THE BRIDGE RATHER THAN A NEW DECISION. `parseSubjectUserId` returns `null`
 * for the anon subject and the bridge has always refused it here, so a block on
 * the postMessage transport already receives nothing for a signed-out viewer
 * today. Keeping the REST twin identical is the bar this surface was asked to
 * meet; widening it would be a NEW disclosure decision taken inside a transport
 * change, which is the wrong place for it.
 *
 * It is also not merely conventional. Three of the four steps genuinely need a
 * viewer: the browsing ceiling is minted FOR a viewer, the blocked-users /
 * blocked-tags exclusion is sourced from a viewer's hidden-prefs, and the one
 * owner branch (`ratingPending`) compares the row's `userId` against the viewer.
 * An anon read would have to answer "which viewer's ceiling?" with a fabricated
 * one.
 *
 * ⚠️ IT IS ALSO A LIVE QUESTION, and it is the SAME one civitai#5089 asks of the
 * `/app-storage/*` five: a signed-out viewer browsing a public app board still
 * wants cover images, and today they get none on either transport. Deciding it
 * means deciding what ceiling an anon viewer reads at and whether the blocked-set
 * exclusion degrades to empty — a moderation decision, not a routing one.
 * Loosening later is a change to this one branch; tightening later would be
 * breaking.
 */
export async function resolveGatedImagesForBlockClaims(input: {
  /**
   * Claims off an ALREADY-VERIFIED block token — `authorizeBlockBridgeToken` on
   * the bridge, `withBlockScope` on REST. This function verifies nothing and must
   * never be handed unverified claims.
   */
  claims: Pick<BlockTokenClaims, 'sub' | 'appId' | 'maxBrowsingLevel'>;
  imageIds: number[];
}): Promise<{ images: BlockGatedImage[] }> {
  const userId = parseSubjectUserId(input.claims.sub);
  if (userId == null) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'gated image read requires an authenticated viewer',
    });
  }

  // App-blocks runtime/visibility gate (the token subject) — NOT the author
  // gate: a viewer of the app can read images the app published.
  await assertAppBlocksEnabledForTokenUser(userId);

  // Dynamic, matching how the bridge procedure has always reached this module: it
  // keeps `dbRead` + the image-upload provenance graph off the import graph of
  // whatever loaded THIS module until a call actually happens — which is what
  // lets a Next API route module import this one cheaply.
  const { getBlockGatedImagesByIds, resolveViewerBrowsingLevel } = await import(
    '~/server/services/blocks/block-gated-images.service'
  );

  // The AUTHORITATIVE per-viewer ceiling for a block surface is the token's
  // maxBrowsingLevel claim (platform-computed at mint), failed closed to PG.
  const browsingLevel = resolveViewerBrowsingLevel(input.claims.maxBrowsingLevel);

  // Scope the read to THIS app's published images (claims.appId) + bind the
  // blocked-users/tags clamp to the viewer (userId).
  return getBlockGatedImagesByIds({
    imageIds: input.imageIds,
    browsingLevel,
    appId: input.claims.appId,
    userId,
  });
}
