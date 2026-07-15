import { TRPCError } from '@trpc/server';

import { dbRead } from '~/server/db/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  classifyCosmeticImageScan,
  type CosmeticImageScanOutcome,
} from '~/server/services/blocks/generator-cosmetic-image.logic';
import type { OffsiteRatingValue } from '~/shared/constants/browsingLevel.constants';
import type { PersistGeneratorCosmeticImageInput } from '~/server/schema/blocks/generator-cosmetic-image.schema';
import type { SessionUser } from '~/types/session';

/**
 * Custom Generators (Phase-2a PR-C) — server glue for the `OPEN_IMAGE_UPLOAD`
 * page-host bridge. The generator builder uploads a cosmetic background; the host
 * modal calls {@link persistGeneratorCosmeticImage} (materialise + REAL scan) then
 * polls {@link gateGeneratorCosmeticImage} until the image is scanned-clean AND
 * within the SFW ceiling, and only THEN hands the moderated id back to the block.
 *
 * The scan-gate DECISION is the pure {@link classifyCosmeticImageScan}
 * (node-unit-tested); this module is the thin dbRead/createImage wiring around it.
 */

/**
 * Materialise a CF-uploaded image into an `Image` row owned by the caller and
 * kick off the STANDARD scan pipeline — `createImage` with DEFAULT ingestion, i.e.
 * NO `skipIngestion` and NEVER `createStoredImage` (which would trust-stamp the
 * bytes as pre-scanned). A public cosmetic image must go through the real NSFW
 * scan; the gate below refuses to return an id until it has. `createImage` is
 * dynamically imported so the heavy `image.service` module stays out of this
 * service's static graph (mirrors `persistListingAssetImage`).
 */
export async function persistGeneratorCosmeticImage(opts: {
  input: PersistGeneratorCosmeticImageInput;
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
 * The gate result the host modal polls: a still-scanning image is a NON-error
 * `{ status: 'pending' }` (re-poll), a clean+SFW image is `{ status: 'ready', … }`
 * with the MINIMAL public projection the block needs to display the background.
 * A TERMINAL failure (not-found / not-owned / scan-blocked / above the SFW ceiling
 * / import-failed) THROWS so the client shows the message + stops polling.
 */
export type GateGeneratorCosmeticImageResult =
  | { status: 'pending' }
  | {
      status: 'ready';
      imageId: number;
      nsfwLevel: number;
      contentRating: OffsiteRatingValue;
      url: string;
    };

/**
 * Map a terminal {@link CosmeticImageScanOutcome} to the client-facing TRPCError.
 * All are BAD_REQUEST — a bad/mature/unfetchable image is a client-correctable
 * upload problem, not an infra fault.
 */
function throwForTerminalOutcome(outcome: CosmeticImageScanOutcome): never {
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
          'that image is above the safe-for-work limit for a public background — choose a SFW image',
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
 * Gate a persisted cosmetic image: assert the caller owns it (or is a mod), then
 * run the pure {@link classifyCosmeticImageScan} over its live scan state. Returns
 * `{ status: 'pending' }` while scanning, `{ status: 'ready', … }` once Scanned +
 * within the SFW ceiling. THROWS NOT_FOUND (missing) / FORBIDDEN (not owned) /
 * BAD_REQUEST (scan-blocked / above-SFW / import-failed).
 */
export async function gateGeneratorCosmeticImage(opts: {
  imageId: number;
  user: SessionUser;
}): Promise<GateGeneratorCosmeticImageResult> {
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
      // reviewed cosmetic background must fail closed on any of them (see the pure
      // classifier). Mirrors PR-B's validateGeneratorBackgroundImage tightening.
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

  const outcome = classifyCosmeticImageScan({
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
      // A displayable edge URL for the (public, SFW) cosmetic background. Minimal
      // projection — no ownership / scan-internal fields reach the block.
      url: getEdgeUrl(image.url, { width: 1200 }),
    };
  }
  return throwForTerminalOutcome(outcome);
}
