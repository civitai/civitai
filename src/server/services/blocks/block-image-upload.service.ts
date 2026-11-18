import { TRPCError } from '@trpc/server';

import { dbRead } from '~/server/db/client';
import { getEdgeUrl } from '~/client-utils/edge-url';
import {
  classifyBlockImageUploadScan,
  isAllowedOutputHost,
  type BlockImageUploadScanOutcome,
} from '~/server/services/blocks/block-image-upload.logic';
import type { OffsiteRatingValue } from '~/shared/constants/browsingLevel.constants';
import {
  BLOCK_GENERATION_SOURCE_APP_ID_META_KEY,
  BLOCK_GENERATION_SOURCE_REF_META_KEY,
  BLOCK_PUBLISHED_APP_ID_META_KEY,
  BLOCK_SHARED_UPLOAD_APP_ID_META_KEY,
  BLOCK_UPLOADED_APP_ID_META_KEY,
} from '~/shared/utils/block-provenance-metadata';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { PersistBlockUploadImageInput } from '~/server/schema/blocks/block-image-upload.schema';
import { measureUploadedImageWithBytes } from '~/server/services/blocks/measure-uploaded-image';
import { storedObjectEtagMetadata } from '~/server/services/blocks/stored-object-integrity';
import { BLOCK_IMAGE_MAX_BYTES } from '~/shared/constants/block-image-upload.constants';
import { sniffImageFormat, type ImageMagicFormat } from '~/shared/utils/image-magic-bytes';
import type { SessionUser } from '~/types/session';
import { uploadImageBufferToStore } from '~/utils/s3-utils';

// The provenance keys live in a module with no env/S3 imports; re-exported for existing callers.
export {
  BLOCK_GENERATION_SOURCE_APP_ID_META_KEY,
  BLOCK_GENERATION_SOURCE_REF_META_KEY,
  BLOCK_POSTABLE_APP_ID_META_KEYS,
  BLOCK_PUBLISHED_APP_ID_META_KEY,
  BLOCK_SHARED_UPLOAD_APP_ID_META_KEY,
  BLOCK_UPLOADED_APP_ID_META_KEY,
} from '~/shared/utils/block-provenance-metadata';

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
 *
 * Dimensions / MIME / byte size are DERIVED FROM THE STORED BYTES; the same fields
 * on the input are ignored. A row created here is attachable as app-listing media
 * (`loadValidatedImage` gates on ownership, not on provenance) and the listing
 * geometry rules read exactly those columns, so persisting the declared values
 * would leave every one of those rules self-reported — issue #3770.
 */
export async function persistBlockUploadImage(opts: {
  input: PersistBlockUploadImageInput;
  userId: number;
  /**
   * The verified token appId of the app whose host-mediated `bytes` upload this is. Stamped as
   * {@link BLOCK_UPLOADED_APP_ID_META_KEY}, and the bytes get the server-side embedded-meta read.
   */
  uploadedByAppId?: string;
  /**
   * Verified appId a viewer-picked upload is shared with (stamped as
   * {@link BLOCK_SHARED_UPLOAD_APP_ID_META_KEY}). Absent leaves the row private. Mutually exclusive
   * with uploadedByAppId.
   */
  sharedWithAppId?: string;
}): Promise<{ imageId: number }> {
  const { input, userId, uploadedByAppId, sharedWithAppId } = opts;
  if (uploadedByAppId && sharedWithAppId) {
    throw new Error('persistBlockUploadImage: pass uploadedByAppId or sharedWithAppId, not both');
  }
  const blockProvenance = uploadedByAppId
    ? { key: BLOCK_UPLOADED_APP_ID_META_KEY, appId: uploadedByAppId }
    : sharedWithAppId
    ? { key: BLOCK_SHARED_UPLOAD_APP_ID_META_KEY, appId: sharedWithAppId }
    : undefined;
  const { measured, bytes } = await measureUploadedImageWithBytes(input.url, {
    maxBytes: BLOCK_IMAGE_MAX_BYTES,
    subject: 'block images',
  });
  // An app's bytes never pass the browser-side parse + audit an on-site upload gets, so the
  // server runs them. The stored prompt reaches the scan like any upload's, so it can make
  // `gateBlockUploadImage` refuse the image.
  let meta: ImageMetaProps | undefined;
  if (uploadedByAppId) {
    const { readEmbeddedImageMeta } = await import('~/server/services/blocks/embedded-image-meta');
    meta = await readEmbeddedImageMeta(bytes);
  }
  // The blurhash placeholder an on-site upload gets from the browser preprocessor. Computed from
  // the same measured bytes; a failure only loses the placeholder, never the upload.
  const { tryComputeImageBlurhash, blurhashMetadata } = await import(
    '~/server/utils/image-blurhash'
  );
  const blur = await tryComputeImageBlurhash(bytes, { source: 'block-upload' });
  const { createImage } = await import('~/server/services/image.service');
  const image = await createImage({
    url: input.url,
    clientUrl: true,
    name: input.name ?? undefined,
    type: 'image',
    meta,
    hash: blur?.hash,
    width: measured.width,
    height: measured.height,
    mimeType: measured.mimeType,
    // Byte size is read from `Image.metadata.size` by the image validators. The
    // entity tag records which stored object they were measured from — a row from
    // here is attachable as listing media, so it must carry the same evidence the
    // listing attach gate re-checks.
    metadata: {
      size: measured.sizeBytes,
      ...storedObjectEtagMetadata(measured.etag),
      ...blurhashMetadata(blur),
    },
    // A server-owned provenance key: `createImage` drops any copy in `metadata`, so this
    // argument is the only way the stamp reaches the row.
    blockProvenance,
    userId,
  });
  return { imageId: image.id };
}

/**
 * Max redirect hops we follow when fetching a workflow output blob. The real
 * orchestrator output url returns a `301` to a SAME-host content url (a relative
 * `Location`), so we must follow at least one hop; the bound stops a redirect loop
 * from stalling the request. Every hop's host is re-validated against
 * {@link isAllowedOutputHost} BEFORE its socket opens.
 */
const MAX_OUTPUT_REDIRECTS = 3;

/** Refusal for a generation-output fetch or store that ran past its caller's deadline. */
export const GENERATION_OUTPUT_DEADLINE_MESSAGE =
  'the generation output took too long to save — try again';

const generationOutputDeadlineError = () =>
  new TRPCError({ code: 'TIMEOUT', message: GENERATION_OUTPUT_DEADLINE_MESSAGE });

/** Throws the deadline refusal when `signal` (the caller's deadline) has fired. */
export function throwIfGenerationOutputDeadlinePassed(signal?: AbortSignal) {
  if (signal?.aborted) throw generationOutputDeadlineError();
}

/**
 * Is this a supported still-image by MAGIC BYTES (not by the url/extension or a
 * spoofable content-type header)? JPEG / PNG / GIF / WEBP. Returns the canonical
 * content-type so the store upload is labelled from the BYTES, not the response.
 * This caller's rules (shared sniffer, {@link sniffImageFormat}): the 4-byte PNG
 * prefix, GIF accepted, and nothing shorter than 12 bytes.
 */
export function sniffSupportedImage(b: Buffer): string | null {
  const format = sniffImageFormat(b, {
    formats: ['jpeg', 'png', 'gif', 'webp'],
    pngSignature: 'prefix',
    minLength: 12,
  });
  return format ? SUPPORTED_IMAGE_CONTENT_TYPE[format] : null;
}

const SUPPORTED_IMAGE_CONTENT_TYPE: Record<ImageMagicFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Hardened fetch of a generation output blob: host-allowlisted ({@link isAllowedOutputHost}),
 * redirects followed manually up to {@link MAX_OUTPUT_REDIRECTS} hops with the host re-validated
 * before each socket opens, byte-capped ({@link BLOCK_IMAGE_MAX_BYTES}), and magic-byte-validated
 * ({@link sniffSupportedImage}). A rejected host / failed fetch / oversize / non-image is a
 * client-correctable upstream problem — BAD_REQUEST.
 */
export async function fetchGenerationOutputImage(
  imageUrl: string,
  /**
   * The caller's deadline. Bounds every hop and the body read on top of the per-hop 60 s
   * timeout; when it fires the fetch fails with the TIMEOUT refusal. Absent: per-hop only.
   */
  signal?: AbortSignal
): Promise<{ bytes: Buffer; contentType: string }> {
  // The real output blob url 301s to a SAME-host content url, so we FOLLOW
  // redirects manually (up to MAX_OUTPUT_REDIRECTS hops) instead of the browser
  // `redirect:'error'`/`'follow'`. `redirect:'manual'` in Node/undici exposes the
  // REAL 3xx status + `location` header (unlike a browser's opaque redirect), and
  // — critically — we re-validate the host against isAllowedOutputHost at the TOP
  // of every hop, BEFORE the socket opens, so a redirect can never reach an
  // off-allowlist host (the SSRF bound holds for every hop, not just the first).
  let response: Response;
  let currentUrl = imageUrl;
  let hops = 0;
  for (;;) {
    throwIfGenerationOutputDeadlinePassed(signal);
    if (!isAllowedOutputHost(currentUrl)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'output url is not an allowed generation host',
      });
    }
    let hopResponse: Response;
    try {
      hopResponse = await fetch(currentUrl, {
        redirect: 'manual', // follow manually so we can re-validate each hop's host
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      });
    } catch {
      throwIfGenerationOutputDeadlinePassed(signal);
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'could not fetch the generation output to publish',
      });
    }
    // A 3xx is the orchestrator's normal same-host content redirect — follow it,
    // re-validating the resolved host on the next loop iteration.
    if (hopResponse.status >= 300 && hopResponse.status < 400) {
      if (hops >= MAX_OUTPUT_REDIRECTS) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'could not fetch the generation output to publish',
        });
      }
      const location = hopResponse.headers.get('location');
      if (!location) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'could not fetch the generation output to publish',
        });
      }
      let resolved: URL;
      try {
        resolved = new URL(location, currentUrl); // resolve relative Location against the hop url
      } catch {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'could not fetch the generation output to publish',
        });
      }
      // Free the redirect response's socket before opening the next hop.
      await hopResponse.body?.cancel().catch(() => undefined);
      currentUrl = resolved.toString();
      hops += 1;
      continue;
    }
    response = hopResponse;
    break;
  }
  if (!response.ok) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'could not fetch the generation output to publish',
    });
  }
  // Reject early on a declared oversize, then hard-cap the buffered bytes.
  const declaredLen = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLen) && declaredLen > BLOCK_IMAGE_MAX_BYTES) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'generation output is too large' });
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throwIfGenerationOutputDeadlinePassed(signal);
    throw error;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > BLOCK_IMAGE_MAX_BYTES) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'generation output is too large' });
  }
  // Validate by MAGIC BYTES (not the spoofable content-type header / url ext).
  const contentType = sniffSupportedImage(bytes);
  if (!contentType) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'generation output is not a supported image',
    });
  }

  return { bytes, contentType };
}

/**
 * A generation output's bytes, fetched by {@link fetchGenerationOutputImage} and landed in the
 * image store, as the fields `createImage` (or `addPostImage`) takes for them. Nothing is written
 * to the database.
 *
 * `width` / `height` are the orchestrator's own projection, never a caller claim. When it did not
 * supply the pair, it is measured from the bytes: ingestion writes scan state only and never
 * re-derives geometry, so this is the only place a missing pair can be filled (issue #3770).
 */
export async function stageGenerationOutputImage({
  imageUrl,
  width,
  height,
  source,
  transform,
  signal,
}: {
  imageUrl: string;
  width: number | null;
  height: number | null;
  /** Names the caller in the blurhash failure log. */
  source: string;
  /** Rewrites the bytes before they are stored; `width` / `height` are then measured from the result. */
  transform?: (bytes: Buffer) => Promise<Buffer>;
  /**
   * The caller's deadline, passed to the fetch and the store PUT. Past it nothing more is
   * stored and the TIMEOUT refusal is thrown. Absent: unchanged behaviour.
   */
  signal?: AbortSignal;
}) {
  const fetched = await fetchGenerationOutputImage(imageUrl, signal);
  const bytes = transform ? await transform(fetched.bytes) : fetched.bytes;
  const contentType = transform ? sniffSupportedImage(bytes) : fetched.contentType;
  if (!contentType)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'generation output is not a supported image',
    });

  // The store the browser-direct upload path uses, so the scanner can read it; `key` is a fresh
  // uuid (satisfies `imageSchema.url`).
  throwIfGenerationOutputDeadlinePassed(signal);
  let key: string;
  try {
    ({ key } = await uploadImageBufferToStore(
      bytes,
      signal ? { contentType, signal } : { contentType }
    ));
  } catch (error) {
    throwIfGenerationOutputDeadlinePassed(signal);
    throw error;
  }

  // The placeholder an on-site upload gets from the browser preprocessor; without it `MediaHash`
  // draws nothing while the image loads. A failure only loses the placeholder.
  const { tryComputeImageBlurhash, blurhashMetadata } = await import(
    '~/server/utils/image-blurhash'
  );
  const blur = await tryComputeImageBlurhash(bytes, { source });
  const useOrchestratorDims = !transform && width != null && height != null;

  return {
    url: key,
    mimeType: contentType,
    hash: blur?.hash,
    width: useOrchestratorDims ? width : blur?.width,
    height: useOrchestratorDims ? height : blur?.height,
    metadata: { size: bytes.byteLength, ...blurhashMetadata(blur) },
  };
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
 * so it can never inject an arbitrary blob. The fetch is HARDENED: host-
 * allowlisted ({@link isAllowedOutputHost}), redirects FOLLOWED MANUALLY up to
 * {@link MAX_OUTPUT_REDIRECTS} hops with the host re-validated against
 * {@link isAllowedOutputHost} BEFORE each hop's socket opens (a real output blob
 * 301s to a same-host content url, so we must follow it, but a redirect can never
 * reach an off-allowlist host), byte-capped ({@link BLOCK_IMAGE_MAX_BYTES}), and
 * magic-byte-validated ({@link sniffSupportedImage} — a spoofed content-type can't
 * smuggle a non-image).
 *
 * The store re-upload uses {@link uploadImageBufferToStore} (the B2 image bucket
 * the edge URL + scanner resolve, with the uuid→backend registration awaited) —
 * NOT Cloudflare Images (whose key 404s at scan time → terminal `NotFound`). The
 * row is created with `createImage` DEFAULT ingestion (NO `skipIngestion`, NEVER
 * `createStoredImage`) so it goes through the genuine NSFW scan, with NO `postId`
 * / NO `modelVersionId` — a BARE Image row, no Post / gallery / feed / reward /
 * notification — and stamped with the {@link BLOCK_PUBLISHED_APP_ID_META_KEY}
 * provenance marker so the cross-user read can scope to THIS app's images.
 * `createImage` is dynamically imported to keep the heavy `image.service` module
 * out of this service's static graph (mirrors {@link persistBlockUploadImage}).
 */
export async function persistBlockWorkflowOutputImage(opts: {
  imageUrl: string;
  width: number | null;
  height: number | null;
  userId: number;
  /** OauthClient id of the publishing app (the token's appId) — provenance marker. */
  appId: string;
}): Promise<{ imageId: number }> {
  const { imageUrl, width, height, userId, appId } = opts;

  const staged = await stageGenerationOutputImage({
    imageUrl,
    width,
    height,
    source: 'block-workflow-output',
  });

  const { createImage } = await import('~/server/services/image.service');
  const image = await createImage({
    url: staged.url,
    type: 'image',
    mimeType: staged.mimeType,
    hash: staged.hash,
    width: staged.width,
    height: staged.height,
    metadata: staged.metadata,
    blockProvenance: { key: BLOCK_PUBLISHED_APP_ID_META_KEY, appId },
    userId,
    // NO postId, NO modelVersionId, NO skipIngestion → a bare, real-scanned Image row.
  });
  return { imageId: image.id };
}

/**
 * App Blocks `PERSIST_GENERATION_SOURCE` — the PRIVATE sibling of
 * {@link persistBlockWorkflowOutputImage}: the same server-side fetch → store → `createImage`
 * (DEFAULT ingestion, so a REAL scan; no post), but stamped
 * {@link BLOCK_GENERATION_SOURCE_APP_ID_META_KEY} instead of the published key, so the row is
 * never on the app's shared grid and is not postable. The caller resolves `imageUrl` from the
 * ownership-verified workflow; the iframe never supplies it.
 *
 * The bytes are fitted inside the workflow source-image bounds (`DIM_MAX`, downscaled only, aspect
 * kept), and the returned width and height are measured from the stored bytes, because the caller
 * hands them to the app as the source's dimension hints, which `blockSourceImageSchema` bounds to
 * `DIM_MIN`..`DIM_MAX`. An output with a side below `DIM_MIN` is refused.
 */
export async function persistBlockGenerationSourceImage(opts: {
  imageUrl: string;
  width: number | null;
  height: number | null;
  userId: number;
  /** OauthClient id of the app (the token's appId) — provenance marker. */
  appId: string;
  /** {@link BLOCK_GENERATION_SOURCE_REF_META_KEY}. */
  ref: string;
  /** The request's deadline: bounds the fetch and the store; past it no row is written. */
  signal?: AbortSignal;
}): Promise<{ imageId: number; url: string; width: number; height: number }> {
  const { imageUrl, width, height, userId, appId, ref, signal } = opts;
  let measured: { width: number; height: number } | undefined;
  const staged = await stageGenerationOutputImage({
    imageUrl,
    width,
    height,
    source: 'block-generation-source',
    signal,
    transform: async (bytes) => {
      const fitted = await fitGenerationSourceBounds(bytes);
      measured = fitted.size;
      return fitted.bytes;
    },
  });
  if (!measured) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'generation output has no dimensions' });
  }

  // The last point the deadline can stop the write: past it the stored object is left
  // unreferenced (as for any refused upload) and no row is created.
  throwIfGenerationOutputDeadlinePassed(signal);
  const metadata = { ...staged.metadata, [BLOCK_GENERATION_SOURCE_REF_META_KEY]: ref };
  const { createImage } = await import('~/server/services/image.service');
  const image = await createImage({
    url: staged.url,
    type: 'image',
    mimeType: staged.mimeType,
    hash: staged.hash,
    width: measured.width,
    height: measured.height,
    metadata,
    blockProvenance: { key: BLOCK_GENERATION_SOURCE_APP_ID_META_KEY, appId },
    userId,
    // NO postId, NO modelVersionId, NO skipIngestion → a bare, real-scanned, private Image row.
  });
  return { imageId: image.id, url: staged.url, width: measured.width, height: measured.height };
}

/**
 * The bytes unchanged when both sides are within `DIM_MAX`, otherwise downscaled to fit inside it
 * (aspect kept), with the size of what is returned. Refuses a side below `DIM_MIN`.
 */
export async function fitGenerationSourceBounds(
  bytes: Buffer
): Promise<{ bytes: Buffer; size: { width: number; height: number } }> {
  const { default: sharp } = await import('sharp');
  const { DIM_MAX, DIM_MIN } = await import('~/server/schema/blocks/workflow.schema');
  const { width, height } = await sharp(bytes).metadata();
  if (!width || !height) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'generation output has no dimensions' });
  }
  let out = bytes;
  let size = { width, height };
  if (width > DIM_MAX || height > DIM_MAX) {
    out = await sharp(bytes)
      .resize({ width: DIM_MAX, height: DIM_MAX, fit: 'inside', withoutEnlargement: true })
      .toBuffer();
    const resized = await sharp(out).metadata();
    if (!resized.width || !resized.height) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'generation output has no dimensions' });
    }
    size = { width: resized.width, height: resized.height };
  }
  if (size.width < DIM_MIN || size.height < DIM_MIN) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `generation output is too small to use as a source (under ${DIM_MIN}px)`,
    });
  }
  return { bytes: out, size };
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
