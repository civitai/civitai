import { TRPCError } from '@trpc/server';

import { dbRead } from '~/server/db/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  classifyBlockImageUploadScan,
  type BlockImageUploadScanOutcome,
} from '~/server/services/blocks/block-image-upload.logic';
import type { OffsiteRatingValue } from '~/shared/constants/browsingLevel.constants';
import type { PersistBlockUploadImageInput } from '~/server/schema/blocks/block-image-upload.schema';
import type { SessionUser } from '~/types/session';
import { fetchBlob } from '~/utils/file-utils';
import { uploadImageBufferToStore } from '~/utils/s3-utils';

/**
 * App Blocks (Phase-2a PR-C) — server glue for the host-mediated `OPEN_IMAGE_UPLOAD`
 * block image-upload bridge. A sandboxed block asks the host to let the user upload
 * an image; the host modal calls {@link persistBlockUploadImage} (materialise +
 * REAL scan) then polls {@link gateBlockUploadImage} until the image is
 * scanned-clean, within the SFW ceiling, and unflagged, and only THEN hands the
 * moderated id back to the block.
 *
 * The scan-gate DECISION is the pure {@link classifyBlockImageUploadScan}
 * (node-unit-tested); this module is the thin dbRead/createImage wiring around it.
 */

/**
 * Materialise a CF-uploaded image into an `Image` row owned by the caller and
 * kick off the STANDARD scan pipeline — `createImage` with DEFAULT ingestion, i.e.
 * NO `skipIngestion` and NEVER `createStoredImage` (which would trust-stamp the
 * bytes as pre-scanned). A publicly-displayed block image must go through the real
 * NSFW scan; the gate below refuses to return an id until it has. `createImage` is
 * dynamically imported so the heavy `image.service` module stays out of this
 * service's static graph (mirrors `persistListingAssetImage`).
 */
export async function persistBlockUploadImage(opts: {
  input: PersistBlockUploadImageInput;
  userId: number;
}): Promise<{ imageId: number }> {
  const { input, userId } = opts;
  const { createImage } = await import('~/server/services/image.service');
  const image = await createImage({
    url: input.url,
    name: input.name ?? undefined,
    type: 'image',
    width: input.width,
    height: input.height,
    mimeType: input.mimeType,
    // Byte size is read from `Image.metadata.size` by the image validators.
    metadata: input.sizeBytes != null ? { size: input.sizeBytes } : undefined,
    userId,
  });
  return { imageId: image.id };
}

/**
 * App Blocks (Phase-1 seam) — SERVER-SIDE sibling of {@link persistBlockUploadImage}
 * whose byte source is a BLOCK-OWNED WORKFLOW OUTPUT (a raw, never-scanned
 * orchestrator URL) instead of a user file upload. Used by
 * `blocks.publishGenerationOutputs` to turn a benchmark grid's own generation
 * outputs into bare, REAL-SCANNED public `Image` rows.
 *
 * SECURITY — the whole fetch→upload→persist happens SERVER-SIDE, so neither the
 * sandboxed iframe NOR the host chrome ever handles the bytes or supplies the
 * URL: the caller (the router) resolves `imageUrl` from the ownership-verified
 * workflow (`blockWorkflowOwnedByAppUser` + the orchestrator app-tag re-read)
 * and passes it here. The iframe only ever sent a `workflowId` + `imageIndexes`,
 * so it can never inject an arbitrary blob.
 *
 * The store re-upload uses {@link uploadImageBufferToStore} (the B2 image bucket
 * the edge URL + scanner resolve, with the uuid→backend registration awaited) —
 * NOT Cloudflare Images (whose key 404s at scan time → terminal `NotFound`). The
 * row is created with `createImage` DEFAULT ingestion (NO `skipIngestion`, NEVER
 * `createStoredImage`) so it goes through the genuine NSFW scan, and with NO
 * `postId` / NO `modelVersionId` — a BARE Image row, no Post / gallery / feed /
 * reward / notification side effects. `createImage` is dynamically imported to
 * keep the heavy `image.service` module out of this service's static graph
 * (mirrors {@link persistBlockUploadImage}).
 */
export async function persistBlockWorkflowOutputImage(opts: {
  imageUrl: string;
  width: number | null;
  height: number | null;
  userId: number;
}): Promise<{ imageId: number }> {
  const { imageUrl, width, height, userId } = opts;

  // Fetch the orchestrator blob (timeout-bounded fetch helper). A missing/failed
  // fetch is a client-correctable upstream problem — BAD_REQUEST, not a 500.
  const blob = await fetchBlob(imageUrl);
  if (!blob) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'could not fetch the generation output to publish',
    });
  }
  const bytes = Buffer.from(await blob.arrayBuffer());
  // Land the bytes in the SAME store the browser-direct upload path uses so the
  // scanner can read them; `key` is a fresh uuid (satisfies `imageSchema.url`).
  const { key } = await uploadImageBufferToStore(bytes, {
    contentType: blob.type || 'image/jpeg',
  });

  const { createImage } = await import('~/server/services/image.service');
  const image = await createImage({
    url: key,
    type: 'image',
    // Dimensions come from the orchestrator projection (may be null when the
    // orchestrator hasn't populated them); ingestion re-measures either way.
    width: width ?? undefined,
    height: height ?? undefined,
    metadata: { size: bytes.byteLength },
    userId,
    // NO postId, NO modelVersionId, NO skipIngestion → a bare, real-scanned Image row.
  });
  return { imageId: image.id };
}

/**
 * The gate result the host modal polls: a still-scanning image is a NON-error
 * `{ status: 'pending' }` (re-poll), a clean+SFW+unflagged image is
 * `{ status: 'ready', … }` with the MINIMAL public projection the block needs to
 * display it. A TERMINAL failure (not-found / not-owned / scan-blocked / above the
 * SFW ceiling / moderation-flagged / import-failed) THROWS so the client shows the
 * message + stops polling.
 */
export type GateBlockUploadImageResult =
  | { status: 'pending' }
  | {
      status: 'ready';
      imageId: number;
      nsfwLevel: number;
      contentRating: OffsiteRatingValue;
      url: string;
    };

/**
 * Map a terminal {@link BlockImageUploadScanOutcome} to the client-facing TRPCError.
 * All are BAD_REQUEST — a bad/mature/flagged/unfetchable image is a client-
 * correctable upload problem, not an infra fault.
 */
function throwForTerminalOutcome(outcome: BlockImageUploadScanOutcome): never {
  switch (outcome.status) {
    case 'import-failed':
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: "that image couldn't be imported — upload it manually instead",
      });
    case 'blocked-scan':
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'that image was rejected during scanning — choose a different image',
      });
    case 'blocked-nsfw':
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'that image is above the safe-for-work limit for a public image — choose a SFW image',
      });
    case 'blocked-flagged':
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'that image was flagged during review — choose a different image',
      });
    // pending / ready are handled by the caller and never reach here.
    default:
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'that image could not be used' });
  }
}

/**
 * Gate a persisted block-uploaded image: assert the caller owns it (or is a mod),
 * then run the pure {@link classifyBlockImageUploadScan} over its live scan state.
 * Returns `{ status: 'pending' }` while scanning, `{ status: 'ready', … }` once
 * Scanned + within the SFW ceiling + unflagged. THROWS NOT_FOUND (missing) /
 * FORBIDDEN (not owned) / BAD_REQUEST (scan-blocked / above-SFW / flagged /
 * import-failed).
 */
export async function gateBlockUploadImage(opts: {
  imageId: number;
  user: SessionUser;
}): Promise<GateBlockUploadImageResult> {
  const { imageId, user } = opts;
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: {
      id: true,
      userId: true,
      url: true,
      ingestion: true,
      nsfwLevel: true,
      // Moderation flags a `Scanned` ingestion does NOT clear — a PUBLIC, un-mod-
      // reviewed block image must fail closed on any of them (see the pure classifier).
      needsReview: true,
      poi: true,
      minor: true,
      tosViolation: true,
    },
  });
  if (!image) throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found' });
  if (image.userId !== user.id && !user.isModerator) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this image' });
  }

  const outcome = classifyBlockImageUploadScan({
    ingestion: image.ingestion,
    nsfwLevel: image.nsfwLevel,
    needsReview: image.needsReview,
    poi: image.poi,
    minor: image.minor,
    tosViolation: image.tosViolation,
  });

  if (outcome.status === 'pending') return { status: 'pending' };
  if (outcome.status === 'ready') {
    return {
      status: 'ready',
      imageId: image.id,
      nsfwLevel: image.nsfwLevel,
      contentRating: outcome.contentRating,
      // A displayable edge URL for the (public, SFW) image. Minimal projection —
      // no ownership / scan-internal fields reach the block.
      url: getEdgeUrl(image.url, { width: 1200 }),
    };
  }
  return throwForTerminalOutcome(outcome);
}
