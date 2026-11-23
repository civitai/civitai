import { TRPCError } from '@trpc/server';
import * as z from 'zod';

import {
  gateBlockUploadImageSchema,
  generationSourceUsesScannedRowsSchema,
  persistBlockUploadImageSchema,
} from '~/server/schema/blocks/block-image-upload.schema';
import { rateLimit } from '~/server/middleware.trpc';
import { assertBlockSubjectIsSessionUser } from '~/server/services/block-token-session-subject';
import { subjectUserIdOrNull } from '~/server/services/block-token-subject';
import { protectedProcedure, router } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

/**
 * App Blocks (Phase-2a PR-C) — the SESSION-AUTHED block image-upload bridge behind
 * the page host's `OPEN_IMAGE_UPLOAD` handler. A sandboxed block asks the host to
 * let the user upload an image; the bytes flow through civitai's OWN authenticated
 * upload path (the block iframe never sees them), so these are `protectedProcedure`
 * (the logged-in user), NOT block-JWT routes and NOT a new block scope — a generic
 * peer of `OPEN_RESOURCE_PICKER`. The optional `share` + block token on `persist` only
 * decide the provenance stamp; the session user is still what authorises the call.
 *
 *   - persist — materialise the CF upload into a scannable `Image` (real
 *     `createImage` + `ingestImage`, NO trust-stamp). PRIVATE by default: the row is
 *     stamped `blockSharedUploadAppId` = the block token's verified appId ONLY when
 *     the app asked to share this one upload (`share: true`) and the host showed the
 *     viewer that it will be visible to the app's other viewers; the app can then
 *     show it to them once scanned (see `persistPickedUploadAppId`). Returns
 *     `shared`: true exactly when that stamp was written.
 *   - gate    — poll the scan; return the moderated id ONLY once scanned-clean,
 *     within the SFW ceiling, and unflagged (else throw). See the service + pure
 *     classifier.
 *   - generationSourceUsesScannedRows — which path a `generationSource` upload takes.
 */
export const blockImageUploadRouter = router({
  persist: protectedProcedure
    .use(
      rateLimit({
        limit: 60,
        period: 3600,
        errorMessage: 'Too many image uploads — slow down.',
      })
    )
    .input(
      persistBlockUploadImageSchema.extend({
        share: z.boolean().optional(),
        blockToken: z.string().min(1).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { blockToken, share, ...upload } = input;
      // Not shared unless asked: without `share: true` the token is ignored and the row stays
      // private. A share request with no token is REFUSED, not stored private, so the app's
      // "visible to other viewers" copy is never shown for an image nobody else will see.
      let sharedWithAppId: string | undefined;
      if (share === true) {
        if (!blockToken) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'sharing an upload requires a block token',
          });
        }
        sharedWithAppId = await persistPickedUploadAppId(blockToken, ctx.user.id);
      }
      const { persistBlockUploadImage } = await import(
        '~/server/services/blocks/block-image-upload.service'
      );
      const { imageId } = await persistBlockUploadImage({
        input: upload,
        userId: ctx.user.id,
        sharedWithAppId,
      });
      // True only because persistBlockUploadImage stamps whenever sharedWithAppId is set, or throws.
      return { imageId, shared: sharedWithAppId !== undefined };
    }),

  gate: protectedProcedure.input(gateBlockUploadImageSchema).mutation(async ({ ctx, input }) => {
    if (!ctx.user) throw throwAuthorizationError('Not authenticated');
    const { gateBlockUploadImage } = await import(
      '~/server/services/blocks/block-image-upload.service'
    );
    return gateBlockUploadImage({ imageId: input.imageId, user: ctx.user });
  }),

  /**
   * Whether a PRIVATE generation source the host just uploaded as a consumer blob (the
   * `generationSource` picker, a single `OPEN_MEDIA_UPLOAD` image) must be kept as a scanned row
   * (`blocks.persistUploadedGenerationSource`) before THIS app can generate from it. It is the
   * gate's own read (`appUsesScannedSourceRows`), for the app named by the block token's
   * `appBlockId` claim, the claim the copy and the gate read too, so the host copies the blob
   * exactly when the gate would refuse it for that app. Off answers false; a flag that cannot be
   * evaluated answers true, as it does for the gate. The token is verified as every bridge call verifies it
   * (`authorizeBlockBridgeToken`); a refused token answers as that refusal.
   */
  generationSourceUsesScannedRows: protectedProcedure
    .input(generationSourceUsesScannedRowsSchema)
    .query(async ({ input }) => {
      const [{ authorizeBlockBridgeToken }, { appUsesScannedSourceRows }] = await Promise.all([
        import('~/server/services/blocks/block-bridge-auth.service'),
        import('~/server/services/blocks/source-scanned-rows'),
      ]);
      const claims = await authorizeBlockBridgeToken(input.blockToken);
      return { scannedRows: await appUsesScannedSourceRows(claims.appBlockId) };
    }),
});

/**
 * The app a SHARED viewer-picked upload is stamped for: the appId of the host's block token, verified as
 * every bridge call verifies it (`authorizeBlockBridgeToken`: signature, expiry, revocation, the
 * backing app still approved), and only when the token's subject (`sub`, `user:<id>`) is the
 * session user doing the upload. A token for anyone else, or an anonymous one, is REFUSED rather
 * than ignored: a share request expects a stamped row, and silently writing an unstamped one would
 * leave the app believing its viewers can see an image nobody else ever will.
 *
 * The appId never comes from the request: it is the verified claim or nothing.
 */
async function persistPickedUploadAppId(blockToken: string, userId: number): Promise<string> {
  const { authorizeBlockBridgeToken } = await import(
    '~/server/services/blocks/block-bridge-auth.service'
  );
  const claims = await authorizeBlockBridgeToken(blockToken);
  // An anonymous or malformed subject reads as null and is refused like another user's.
  assertBlockSubjectIsSessionUser(
    subjectUserIdOrNull(claims.sub),
    userId,
    'block token is not for this viewer'
  );
  return claims.appId;
}
