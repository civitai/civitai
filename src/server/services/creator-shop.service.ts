import { Prisma } from '@prisma/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { isEqual } from 'lodash-es';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { dbRead, dbWrite } from '~/server/db/client';
import { refreshOwnedStickerCache } from '~/server/redis/caches';
import {
  recordShopTakedownArtwork,
  type ShopTakedownArtwork,
} from '~/server/services/cdn-access.service';
import { queueCosmeticPerceptualHash } from '~/server/services/cosmetic-phash.service';
import {
  excludeDeletedShopListing,
  recordShopTakedownLabel,
  recordShopVerdict,
  SHOP_VERDICT_TRANSACTION,
} from '~/server/services/creator-shop-labels.service';
import {
  revokeCosmeticsFromUsers,
  unequipWithheldCosmetic,
  validateStickerCosmetic,
} from '~/server/services/cosmetic.service';
import { removePlacementsByCosmetic } from '~/server/services/placement-moderation.service';
import {
  claimBoxRefundsForCosmetic,
  listOwedBoxRefunds,
  markBoxRefundPaid,
  pullCosmeticFromBoxes,
  type OwedBoxRefund,
} from '~/server/services/mystery-box-takedown.service';
import { getPrefixRefundState, refundAllLegsByPrefix } from '~/server/services/buzz-prefix-refund';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import { isAllowedImageScanUrl, normalizeImageScanUrl } from '~/server/utils/image-scan-url';
import { isEdgeUrlPassthrough } from '~/shared/utils/edge-url-passthrough';
import { constants } from '~/server/common/constants';
import {
  REJECTED_IS_FINAL,
  appendItemHistory,
  buildCosmeticData,
  changesDisplay,
  creatorGrantRemaining,
  edgesBeyondCreatorRange,
  isListingDisplayable,
  patchCosmeticData,
  recordedDisplayVerdict,
  shopItemDisplayMeta,
  shopItemReviewVersion,
  wasLastReviewARejection,
} from '~/server/services/creator-shop.data';
import {
  refundWithdrawnShopItem,
  reversePurchase,
  withShopItemRefundLock,
} from '~/server/services/creator-shop-withdrawn-refund.service';
import type { StickerEconomics } from '~/shared/utils/sticker-token';
import { CosmeticFlag } from '~/shared/constants/cosmetic-flags.constants';
import {
  stickerEconomicsFromCosmeticData,
  stickerSlugSearchTerm,
} from '~/shared/utils/sticker-token';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import {
  createBuzzTransaction,
  refundMultiAccountTransaction,
  refundTransaction,
} from '~/server/services/buzz.service';
import {
  assertQuotedFee,
  getCreatorShopSubmissionFee,
} from '~/server/services/creator-shop-fees.service';
import { createNotification } from '~/server/services/notification.service';
import { getBlockedPairIds } from '~/server/services/user-preferences.service';
import { CosmeticShopSort, NotificationCategory } from '~/server/common/enums';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
  withRetries,
} from '~/server/utils/errorHandling';
import { logToAxiom } from '~/server/logging/client';
import {
  CosmeticShopItemStatus,
  CosmeticSource,
  CosmeticType,
  MediaType,
  ModelStatus,
  ServiceOfferingStatus,
} from '~/shared/utils/prisma/enums';
import type {
  CosmeticPurchaseMeta,
  CosmeticShopItemHistoryChange,
  CosmeticShopItemMeta,
} from '~/server/schema/cosmetic-shop.schema';
import { cosmeticShopItemSelect } from '~/server/selectors/cosmetic-shop.selector';
import { getSoldCounts } from '~/server/services/cosmetic-shop-sold-count';
import { delistPacksContaining } from '~/server/services/creator-shop-pack.service';
import { assertNotInLiveMysteryPack } from '~/server/services/creator-mystery-pack.service';
import { reviewMysteryPack } from '~/server/services/creator-mystery-pack-approve.service';
import { lockShopItem } from '~/server/services/creator-shop-lock';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

// The shop-item shape, which already carries the creator and lister for
// attribution. Only used by the creator storefront.
const creatorStorefrontItemSelect = Prisma.validator<Prisma.CosmeticShopItemSelect>()({
  ...cosmeticShopItemSelect,
  // Approval time, so a storefront's "Newest" means the same thing the
  // community hub's does rather than falling back to submission order.
  reviewedAt: true,
});

import type { UserSettingsSchema } from '~/server/schema/user.schema';
import { bustUserSettings, patchUserSettings } from '~/server/services/user.service';
import { bustUserCreator } from '~/server/services/user-creator.service';
import {
  CREATOR_OFFSET_LIMIT,
  STICKER_DEFAULT_USES,
  STICKER_MIN_BUZZ_PER_USE,
  cosmeticPriceFloor,
  stickerPerUseFloor,
  MAX_ANIMATION_FPS,
  MAX_ANIMATION_FRAMES,
  MIN_ANIMATION_FRAME_DELAY_MS,
  PRICE_REVIEW_THRESHOLD,
  RIGHTS_AFFIRMATION_STATEMENT,
  RIGHTS_AFFIRMATION_VERSION,
  MYSTERY_PACK_FILTER_VALUE,
  PACK_FILTER_VALUE,
  PACK_SHOP_ITEM_WHERE,
  cosmeticDimensionsLabel,
  cosmeticDimensionsPass,
  cosmeticImageRequirements,
} from '~/server/schema/creator-shop.schema';
import type {
  AutoCheck,
  CosmeticImageMeta,
  CosmeticOffsets,
  GetCommunityCosmeticsInput,
  GetEarlyAccessPricesInput,
  GetPublicShopItemsInput,
  GetReviewQueueInput,
  GetShopItemResellersInput,
  ReorderResoldItemsInput,
  ResoldItemInput,
  ReviewCreatorShopItemInput,
  SubmitCreatorShopItemInput,
  TakedownCosmeticShopItemInput,
  UpdateCreatorShopItemInput,
  UpdateCreatorShopSettingsInput,
} from '~/server/schema/creator-shop.schema';
import { type ModelVersionTerms } from '@civitai/buzz';
import { getPaidAccess, getViewerMonetization } from '~/server/services/paid-access.service';
import {
  assertClientImageUrlsUsable,
  assertShopArtworkKeysIssued,
} from '~/server/services/image-url-ownership';

// Shop surfaces hide stickers until the flag is on. Rendering is never gated —
// an owned sticker in a comment or DM shows for everyone regardless.
// A `cosmetic` relation filter is an EXISTS on a nullable to-one, so ANY
// condition nested under it silently excludes every pack. The pack branch keeps
// them visible; a pack containing stickers is refused at purchase either way.
// A mystery box listing has no cosmetic either, and is not a pack.
const hideStickers = (stickersEnabled?: boolean, packsEnabled?: boolean) =>
  stickersEnabled
    ? packsEnabled
      ? { itemDefinitionId: null }
      : { cosmeticId: { not: null } }
    : {
        OR: [
          ...(packsEnabled ? [PACK_SHOP_ITEM_WHERE] : []),
          { cosmetic: { type: { not: CosmeticType.Sticker } } },
        ],
      };

// Card/listing shape for the creator management + moderator views.
const creatorShopItemSelect = Prisma.validator<Prisma.CosmeticShopItemSelect>()({
  id: true,
  unitAmount: true,
  title: true,
  description: true,
  availableQuantity: true,
  availableFrom: true,
  availableTo: true,
  status: true,
  listed: true,
  rejectionReason: true,
  reviewedAt: true,
  createdAt: true,
  meta: true,
  cosmetic: {
    select: {
      id: true,
      name: true,
      type: true,
      data: true,
      videoUrl: true,
      createdById: true,
      source: true,
      description: true,
    },
  },
  _count: { select: { purchases: true } },
});

type CreatorShopItemRow = Prisma.CosmeticShopItemGetPayload<{
  select: typeof creatorShopItemSelect;
}>;

const withRemaining = (item: Omit<CreatorShopItemRow, '_count'>, purchases: number) => {
  const remaining = item.availableQuantity != null ? item.availableQuantity - purchases : null;
  return { ...item, purchases, remaining, soldOut: remaining != null && remaining <= 0 };
};

// The cosmetic `data` blob is built server-side (never trust client-shaped data).
// Server-side artwork validation (source of truth). Fetches the original upload
// and inspects it with sharp against the per-type requirements.
/**
 * Bounds on the artwork fetch below. These cap what the WEB POD will spend on one
 * `submitCreatorShopItem` call.
 *
 * 🔴 THE SIZE BOUND IS THE PRODUCT'S OWN LIMIT, DELIBERATELY — not a second, tighter number.
 * An earlier draft minted `20 MiB`, sized by analogy to `META_IMAGE_MAX_BYTES` (6 MiB) in
 * `listing-meta.service.ts`. That was wrong in a way no test would have caught: the creator
 * is told **"Under 50 MB"** (`creator-shop.validation.ts`), the dropzone enforces
 * `constants.mediaUpload.maxImageFileSize` (`useSubmitCreatorShopForm.ts`), and no cosmetic
 * type except `Sticker` has an upper DIMENSION bound at all — so a 30 MB `ProfileBackground`
 * is ordinary, not pathological. At 20 MiB it would pass every client check, upload fine, and
 * then be refused server-side with the generic "Could not read the uploaded artwork". Reading
 * the same constant closes that dead window by construction and cannot drift from it.
 */
export const ARTWORK_MAX_BYTES = constants.mediaUpload.maxImageFileSize;

/**
 * 🔴 DERIVED FROM THE CAP, NOT SET BESIDE IT — because setting it beside the cap is exactly
 * how this went wrong once. An earlier draft paired `15_000` with a 20 MiB cap; the cap then
 * rose 2.5x to the product's 50 MiB limit and the timeout was left untouched, silently
 * demanding ~3.5 MB/s sustained to move a legal upload — TIGHTER than both precedents this
 * change cites (`listing-meta.service.ts` and `og-image-helpers.ts` both budget ~2.4 MB/s).
 * That reopened, in the TIME axis, the same dead window the docblock above closes in the BYTE
 * axis: a 38 MB `ProfileBackground` on a cold edge cache passes every client check, then fails
 * server-side with the generic "Could not read the uploaded artwork".
 *
 * So the budget is a THROUGHPUT, and the timeout falls out of it. Raising the cap now moves
 * the timeout with it and the two cannot drift apart again.
 *
 * `ARTWORK_MIN_THROUGHPUT_BPS` is deliberately slacker than either precedent: unlike them this
 * fetch absorbs a 301 leg to `blobs-b2.civitai.com` plus a possible cold-cache B2 pull, and a
 * wrong rejection blocks a submission.
 */
const ARTWORK_MIN_THROUGHPUT_BPS = 2_000_000;
const ARTWORK_FETCH_TIMEOUT_MS = Math.ceil((ARTWORK_MAX_BYTES / ARTWORK_MIN_THROUGHPUT_BPS) * 1000);

/**
 * Read a response body into a Buffer, aborting as soon as the running total exceeds
 * `maxBytes` — so an oversize body is never fully materialised in the web pod's heap.
 *
 * This is what makes the cap a real memory bound rather than a late assertion about one that
 * already happened: `res.arrayBuffer()` would materialise the whole body first, and a check
 * after it can only decide what to hand onward, not what was allocated.
 *
 * `cancel()` on the reader releases the connection rather than leaving the rest of the body
 * to stream into a socket nobody is draining.
 *
 * ⚠ A body with NO readable stream falls back to `arrayBuffer()`. That path is unbounded by
 * construction and exists only for fetch implementations (and test mocks) that expose no
 * `body`; the Content-Length pre-check is the only bound there. Real undici always gives a
 * stream, so production never takes it.
 */
export async function readBounded(
  res: { body?: unknown; arrayBuffer(): Promise<ArrayBuffer> },
  maxBytes: number
) {
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== 'function') {
    return Buffer.from(await res.arrayBuffer());
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // 🔴 THROW, never `continue`. A spec-compliant stream always carries a chunk when
      // `done` is false and undici only ever enqueues a Uint8Array, so this is unreachable
      // today — but `continue` turns "unreachable" into an UNRECOVERABLE wedge if it ever
      // happens: an await-loop whose promise resolves immediately starves the macrotask
      // queue, so the AbortSignal timer CANNOT fire and rescue it.
      //
      // MEASURED, 60,000,000 iterations of exactly that shape against a 300 ms
      // `AbortSignal.timeout`, `signal.aborted === false` at the end of every run. Two
      // independent measurements on this host: 2,053 / 2,105 ms, and 2,904 / 3,445 ms — so
      // 6.8x to 11.5x the budget. Node v24.20.0 (the host); this repo's own dev shell pins
      // v24.19.0, and both were measured.
      //
      // ⚠ THIS IS THE THIRD FIGURE WRITTEN HERE. If you are about to replace it, you are the
      // fourth — so record what you measured rather than reasoning about it. The first draft
      // cited no elapsed time at all ("6,000,000 iterations … had still not fired"), which is
      // why it demonstrated nothing: a starvation claim needs an elapsed time that EXCEEDS the
      // timeout, and that draft reported none. That alone retires it. The second draft then
      // asserted 6,000,000 iterations complete in 227–270 ms, i.e. INSIDE the budget — do not
      // reinstate THAT either, but not because it is too low: an independent re-measurement of
      // the same shape on the same host got 345–408 ms over 10 runs, i.e. ABOVE the budget.
      // 6,000,000 straddles 300 ms under ordinary load variance (the two runs differ ~1.5x, and
      // load was ~52 on 24 cores during the slower one), so at that count the result is
      // indistinguishable from the budget and cannot settle anything either way. Pick a count
      // whose margin survives a busy machine; 60,000,000 does.
      //
      // That is the event-loop-freeze class, and it would take out the whole web pod rather
      // than one request. The branch bought nothing; failing loudly costs nothing.
      if (!value) throw new Error('artwork stream produced an empty chunk');
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`artwork too large: exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

const validateArtwork = async (imageUrl: string, type: CosmeticType) => {
  // 🔴 SSRF + RESPONSE ORACLE. This is the sharpest of the caller-supplied-URL funnels and
  // the only one that fetches from the NEXT.JS WEB POD rather than via the orchestrator:
  // `getEdgeUrl` forwards an absolute http(s) url unmodified, and everything derived from
  // the response below — `imageHash` (a sha256 of the body), width, height, format, frame
  // count — is returned to the submitter. Ungated that is a read primitive over any URL the
  // web pod can reach, on `creatorShopProcedure` (protectedProcedure + the `creatorShop`
  // flag).
  //
  // ⚠ CORRECTED: this used to read "i.e. an ordinary signed-in user rather than a moderator",
  // which OVERSTATES the rung — and the rung is what the controls here are priced against.
  // Measured: `feature-flags.service.ts` declares `creatorShop: { availability: ['mod'],
  // fliptKey: 'creator-shop' }`, and live Flipt enables it for the segments
  // `testers` ∪ `CreatorProgram` ∪ `moderators`. So the reachable population is a GATED
  // COHORT OF REAL USERS, not every signed-in account. The hazard stands — Creator Program
  // members are not moderators, and the response returns derived bytes to the submitter — but
  // do not re-derive "any signed-in user" from this comment.
  //
  // 🔴 The check MUST stay OUTSIDE the try/catch below. That catch converts every failure
  // into 'Could not read the uploaded artwork for validation', so a refusal raised inside it
  // would be reported as an unreadable image — and a test asserting the refusal would pass
  // on the generic message while proving nothing about the allowlist.
  //
  // 🔴 NARROWED from `isAllowedImageScanUrl` to "must be a RELATIVE storage key", which is
  // strictly tighter and is what makes the host below OURS BY CONSTRUCTION rather than
  // merely allowlisted. The ingestion allowlist admits absolute URLs on hosts an attacker
  // can put bytes on — `<any-bucket>.s3.wasabisys.com` is a self-service global namespace,
  // and `*.civitai.com` is admitted on any port with any path (both documented in
  // `image-scan-url.ts`). That breadth is correct for INGESTION, which has a legacy
  // `Image.url` population to keep working; it is wrong here, where there is none:
  //   * every client call site sends a Cloudflare upload id — `useSubmitCreatorShopForm.ts`
  //     and `CreatorShopPackModal.tsx` all pass `imageId`;
  //   * `submitCreatorShopItemSchema` types it as a bare `z.string().min(1)`, so the schema
  //     never constrained it and nothing else does;
  //   * the error string this throws has ALWAYS claimed the narrower rule.
  // 🔴 `isEdgeUrlPassthrough` is the single predicate `getEdgeUrl` itself branches on, so
  // "not passthrough" means exactly "getEdgeUrl will prefix this onto our own storage edge".
  // Reusing it rather than spelling a fourth test is the whole point of that module.
  if (!imageUrl || isEdgeUrlPassthrough(imageUrl)) {
    throw throwBadRequestError('Artwork must be an image uploaded to Civitai');
  }
  // Belt and braces: a relative key must also be free of the parser-ambiguous bytes the
  // ingestion guard refuses. `\\evil.com/x` and `/\evil.com/x` carry no scheme and no leading
  // `//`, so they read as relative keys here, and a WHATWG parser given a base resolves all
  // of them to host `evil.com`. `isAllowedImageScanUrl` applies this to BOTH branches before
  // it splits, so narrowing to the relative branch must not drop it.
  if (!isAllowedImageScanUrl(imageUrl)) {
    throw throwBadRequestError('Artwork must be an image uploaded to Civitai');
  }

  const req = cosmeticImageRequirements(type);

  let width = 0;
  let height = 0;
  let format: string | undefined;
  let hasTransparency = false;
  let imageHash = '';
  let frames = 1;
  let minFrameDelay = Infinity;
  try {
    // `normalizeImageScanUrl` is a no-op on a relative key (it only re-emits the parsed href
    // of a passthrough url, and the guard above rejected every one of those). It is kept so
    // the call reads the same as the orchestrator funnels and does not become the one site
    // that forwards a raw string if the predicate above is ever widened again.
    //
    // 🔴 NOT `safeFetch`, and that is a measured decision rather than an oversight.
    // `src/server/utils/safe-fetch.ts` is this repo's guarded outbound primitive and is the
    // right tool for an ARBITRARY url — but it gates on `isPublicHttpsUrl`, i.e. https-only
    // and a public dotted hostname. The url here is OUR OWN edge, and `.env-example` sets
    // `NEXT_PUBLIC_IMAGE_LOCATION=http://localhost:3000`, which that gate rejects on both
    // counts — so routing this call through it would break artwork validation in every local
    // dev environment while adding nothing in production that the narrowing above has not
    // already achieved. The controls that DO apply regardless of scheme are applied instead:
    //
    //   AbortSignal.timeout — an unbounded fetch on the WEB POD is a request-pinning DoS
    //     independent of where it points.
    //   a size cap — enforced on the Content-Length AND, because a chunked response carries
    //     none to pre-check, by READING THE BODY AS A STREAM and aborting the moment the
    //     running total exceeds the cap.
    //
    // 🔴 The stream is the point, and an earlier draft got this wrong while claiming
    // otherwise. It called `await res.arrayBuffer()` and THEN checked `buffer.byteLength`,
    // under a comment asserting the check kept a large object out of the pod's heap. It could
    // not: by the time that guard runs the body is already fully materialised, and
    // `Buffer.from` has copied it, so peak heap is ~2x the body BEFORE the check executes.
    // The guard delivered only "sharp is not handed more than the cap" — a weaker property
    // than the sentence above it claimed. Its own fixture gave it away, allocating the exact
    // 64 MiB it was supposed to prevent.
    // 🔴 REDIRECTS ARE FOLLOWED, and an earlier draft of this change got that wrong in a way
    // that would have broken EVERY submission. It set `redirect: 'error'`, reasoning that
    // since the host is ours by construction a 3xx is the only way left to reach a host we
    // did not choose. MEASURED against the real edge, that reasoning is built on a false
    // premise: an `original=true` delivery URL answers **HTTP 301** to
    // `https://blobs-b2.civitai.com/file/blobs-managed-public/<id>` — three of three sampled
    // live images. Redirecting to our own blob host is the NORMAL path, not an anomaly, so
    // `redirect: 'error'` rejects every legitimate artwork fetch.
    //
    // Following them is also SAFE here, and specifically because of the narrowing above: the
    // caller supplies a storage KEY, never a host, so the redirect chain is chosen by our own
    // infrastructure and is not an attacker-influenced primitive. That is the property the
    // narrowing bought — before it, an allowlisted attacker-controlled host could redirect
    // anywhere, and THAT is the hazard `redirect: 'error'` was reaching for. It was the right
    // instinct aimed at a hazard the line above had already closed.
    const res = await fetch(getEdgeUrl(normalizeImageScanUrl(imageUrl), { original: true }), {
      signal: AbortSignal.timeout(ARTWORK_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const declaredLength = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declaredLength) && declaredLength > ARTWORK_MAX_BYTES) {
      throw new Error(`artwork too large: ${declaredLength} bytes`);
    }
    const buffer = await readBounded(res, ARTWORK_MAX_BYTES);
    imageHash = createHash('sha256').update(buffer).digest('hex');
    const meta = await sharp(buffer).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    format = meta.format;
    hasTransparency = !!meta.hasAlpha;
    frames = meta.pages ?? 1;
    if (meta.delay?.length) minFrameDelay = Math.min(...meta.delay);
  } catch {
    throw throwBadRequestError('Could not read the uploaded artwork for validation');
  }

  const checks: AutoCheck[] = [
    {
      key: 'format',
      label: 'PNG or WebP',
      passed: format === 'png' || format === 'webp',
      detail: format,
    },
    {
      key: 'dimensions',
      label: cosmeticDimensionsLabel(req),
      passed: cosmeticDimensionsPass(req, width, height),
      detail: `${width}×${height}px`,
    },
  ];
  if (req.requireTransparency)
    checks.push({ key: 'transparency', label: 'Transparent background', passed: hasTransparency });
  if (frames > 1) {
    checks.push({
      key: 'frameCount',
      label: `At most ${MAX_ANIMATION_FRAMES} frames`,
      passed: frames <= MAX_ANIMATION_FRAMES,
      detail: `${frames} frames`,
    });
    checks.push({
      key: 'frameRate',
      label: `At most ${MAX_ANIMATION_FPS} fps`,
      // A 0ms delay ("as fast as possible") also fails; missing delay info
      // (Infinity) can't be judged so it passes.
      passed: minFrameDelay >= MIN_ANIMATION_FRAME_DELAY_MS,
      detail: Number.isFinite(minFrameDelay)
        ? `~${Math.round(1000 / Math.max(1, minFrameDelay))} fps peak`
        : undefined,
    });
  }

  const imageMeta: CosmeticImageMeta = { width, height, hasTransparency };
  return { checks, imageMeta, imageHash, allPassed: checks.every((c) => c.passed) };
};

// Blocks re-submitting artwork already in the shop. Exact-match (sha256) — a
// re-encode/resize would slip past, but it catches accidental & copy re-uploads.
const findDuplicateArtwork = async (imageHash: string, excludeId?: number) => {
  if (!imageHash) return null;
  return dbRead.cosmeticShopItem.findFirst({
    where: {
      meta: { path: ['imageHash'], equals: imageHash },
      status: {
        notIn: [CosmeticShopItemStatus.Archived, CosmeticShopItemStatus.Rejected],
      },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
};

// The affirmation is stored with its wording, not just a flag, so a later
// takedown challenge can show what the submitter actually agreed to.
const buildRightsAffirmation = (userId: number) => ({
  userId,
  affirmedAt: new Date().toISOString(),
  version: RIGHTS_AFFIRMATION_VERSION,
  statement: RIGHTS_AFFIRMATION_STATEMENT,
});

const assertCreatorOffsets = (next: CosmeticOffsets, stored?: CosmeticOffsets | null) => {
  const edges = edgesBeyondCreatorRange(next, stored);
  if (edges.length)
    throw throwBadRequestError(
      `Fit offsets can be at most ${CREATOR_OFFSET_LIMIT}px per edge (${edges.join(', ')})`
    );
};

const offsetsLabel = (offsets?: CosmeticOffsets | null) =>
  offsets ? `T${offsets.top} R${offsets.right} B${offsets.bottom} L${offsets.left}` : undefined;

// ---------------------------------------------------------------------------
// Creator: submit & manage
// ---------------------------------------------------------------------------

export const submitCreatorShopItem = async ({
  userId,
  cosmeticType,
  name,
  description,
  imageUrl,
  animated,
  price,
  availableQuantity,
  buzzType,
  sellableByOthers,
  sellerShare,
  acceptsBlueBuzz,
  offsets,
  slug,
  uses,
  pricePerUse,
  rightsAffirmed,
  quotedFee,
}: SubmitCreatorShopItemInput & { userId: number }) => {
  // Submitters are held to the creator range, moderators included: a moderator widens the fit
  // afterwards on the review page.
  if (offsets) assertCreatorOffsets(offsets);

  // The same CosmeticShopItem.title/description columns the moderator-only upsert guards; these
  // are the CREATOR-facing doors into them. Guarding only the moderator one would have closed
  // the lower-risk door and left these open.
  await throwOnBlockedUserContent([name, description], { surface: 'creatorShop' });

  // The zod schema already requires it; this keeps the item from ever being
  // created without the record if the service is called from anywhere else.
  if (!rightsAffirmed)
    throw throwBadRequestError('You must confirm you have the rights to sell this artwork');

  // The zod floor is the cross-type minimum; this is the real, type-dependent one.
  const priceFloor = cosmeticPriceFloor(cosmeticType);
  if (price < priceFloor)
    throw throwBadRequestError(`This cosmetic type must be listed for at least ${priceFloor} Buzz`);

  // Stickers are consumable, so the price also has to clear a per-use floor —
  // otherwise a cheap listing with a huge use count undercuts the economics.
  const stickerUses =
    cosmeticType === CosmeticType.Sticker ? uses ?? STICKER_DEFAULT_USES : undefined;
  if (stickerUses && price < stickerUses * STICKER_MIN_BUZZ_PER_USE)
    throw throwBadRequestError(
      `${stickerUses} uses needs at least ${
        stickerUses * STICKER_MIN_BUZZ_PER_USE
      } Buzz (${STICKER_MIN_BUZZ_PER_USE} per use)`
    );

  // Top-up price is sticker-only and has its own floor — the list floor governs
  // an offer of N uses, which is a different thing from one use.
  const stickerPricePerUse = cosmeticType === CosmeticType.Sticker ? pricePerUse : undefined;
  const perUseFloor = stickerPerUseFloor(cosmeticType);
  if (stickerPricePerUse && stickerPricePerUse < perUseFloor)
    throw throwBadRequestError(`A single use must cost at least ${perUseFloor} Buzz`);

  // Validate the artwork server-side BEFORE charging anything.
  const { checks, imageMeta, imageHash, allPassed } = await validateArtwork(imageUrl, cosmeticType);
  if (!allPassed)
    throw throwBadRequestError('Artwork does not meet the requirements for this cosmetic type');
  await assertClientImageUrlsUsable({ urls: [imageUrl], userId, shopRow: {} });
  await assertShopArtworkKeysIssued({ urls: [imageUrl], userId });

  // Reject duplicate artwork before charging the fee.
  if (await findDuplicateArtwork(imageHash))
    throw throwBadRequestError('This artwork has already been submitted to the shop.');
  checks.push({ key: 'duplicate', label: 'Original artwork', passed: true });

  // Slug format + collision, also before charging: finding out your slug is
  // taken after paying a non-refundable fee is the worst version of this.
  const normalizedSlug = slug?.trim().toLowerCase();
  await validateStickerCosmetic({ type: cosmeticType, data: { slug: normalizedSlug } });

  // Charge the (non-refundable) submission fee; refunded only if the write fails.
  const submissionFee = await getCreatorShopSubmissionFee(cosmeticType);
  assertQuotedFee(quotedFee, submissionFee);
  const feeTx = await createBuzzTransaction({
    fromAccountId: userId,
    fromAccountType: buzzType as BuzzSpendType,
    toAccountId: 0,
    amount: submissionFee,
    type: TransactionType.Purchase,
    description: `Creator Shop submission fee - ${name}`,
    externalTransactionId: `creator-shop-submit-${userId}-${Date.now()}`,
  });
  const feeTxId = feeTx.transactionId;
  if (!feeTxId) throw throwBadRequestError('Unable to charge the submission fee');

  try {
    // Captured out of the transaction so the hash can be queued after it commits
    // — the request is a network round-trip and has no business inside a write
    // transaction, and a cosmetic that exists without a hash is invisible to
    // review. This path is why 228 of the 231 unhashed cosmetics on 2026-08-14
    // were creator submissions.
    let submittedCosmeticId: number | undefined;
    const created = await dbWrite.$transaction(async (tx) => {
      const cosmetic = await tx.cosmetic.create({
        data: {
          name,
          description: description ?? null,
          type: cosmeticType,
          source: CosmeticSource.Purchase,
          permanentUnlock: true,
          data: buildCosmeticData(cosmeticType, imageUrl, animated, offsets, normalizedSlug, {
            uses: stickerUses,
            pricePerUse: stickerPricePerUse,
          }) as Prisma.InputJsonValue,
          createdById: userId,
        },
      });
      submittedCosmeticId = cosmetic.id;

      return tx.cosmeticShopItem.create({
        data: {
          cosmeticId: cosmetic.id,
          unitAmount: price,
          title: name,
          description: description ?? null,
          availableQuantity: availableQuantity ?? null,
          addedById: userId,
          status: CosmeticShopItemStatus.PendingReview,
          meta: {
            purchases: 0,
            submissionTxId: feeTxId,
            submissionFee,
            autoChecks: checks,
            imageMeta,
            imageHash,
            sellableByOthers,
            sellerShare: sellableByOthers ? sellerShare : 0,
            acceptsBlueBuzz,
            rightsAffirmation: buildRightsAffirmation(userId),
            history: [
              {
                at: new Date().toISOString(),
                userId,
                kind: 'submitted',
                status: CosmeticShopItemStatus.PendingReview,
              },
            ],
          } satisfies CosmeticShopItemMeta,
        },
        select: creatorShopItemSelect,
      });
    });

    if (submittedCosmeticId)
      queueCosmeticPerceptualHash({ id: submittedCosmeticId, url: imageUrl });

    return created;
  } catch (error) {
    await refundTransaction(feeTxId, 'Creator Shop submission failed');
    throw error;
  }
};

// Load an item and assert the caller may manage it (its creator, or a moderator). From the primary:
// callers write `meta` back built from this row, and a lagging replica would hand them a pre-verdict one.
const getOwnedItemOrThrow = async (id: number, userId: number, isModerator = false) => {
  const item = await dbWrite.cosmeticShopItem.findUnique({
    where: { id },
    select: {
      id: true,
      cosmeticId: true,
      unitAmount: true,
      status: true,
      title: true,
      meta: true,
      addedById: true,
      // Archiving overwrites `status`, so on the restore path this column is the
      // only thing left on an item that predates the history log.
      rejectionReason: true,
      // Prior values, so an edit can record what it moved from.
      description: true,
      availableQuantity: true,
      itemDefinitionId: true,
      cosmetic: { select: { id: true, createdById: true, type: true, data: true } },
      _count: { select: { purchases: true } },
    },
  });
  if (!item) throw throwNotFoundError('Shop item not found');
  // Ownership is the lister (addedById), which may differ from the cosmetic's
  // original creator for cross-listed items.
  if (!isModerator && item.addedById !== userId)
    throw throwAuthorizationError('You can only manage your own shop items');
  return item;
};

export const updateCreatorShopItem = async ({
  userId,
  isModerator,
  id,
  name,
  description,
  imageUrl,
  animated,
  price,
  availableQuantity,
  acceptsBlueBuzz,
  sellableByOthers,
  sellerShare,
  offsets,
  slug,
  uses,
  pricePerUse,
  rightsAffirmed,
}: UpdateCreatorShopItemInput & { userId: number; isModerator?: boolean }) => {
  const existing = await getOwnedItemOrThrow(id, userId, isModerator);

  // AFTER the ownership check, deliberately. The rejection names the matched entry, so running it
  // first turns this endpoint into a membership oracle for anyone holding someone else's id.
  await throwOnBlockedUserContent([name, description], { isModerator, surface: 'creatorShop' });
  // A pack has no cosmetic of its own; everything below edits one.
  if (existing.cosmeticId == null || existing.cosmetic == null)
    throw throwBadRequestError('Packs are edited through the pack editor');
  // Rejected is terminal; archived items must be restored before editing.
  if (existing.status === CosmeticShopItemStatus.Rejected)
    throw throwBadRequestError(REJECTED_IS_FINAL);
  if (existing.status === CosmeticShopItemStatus.Archived)
    throw throwBadRequestError('Archived items cannot be edited');

  // Fit offsets only apply to avatar decorations; undefined = keep, null = clear.
  const isDecoration = existing.cosmetic.type === CosmeticType.ProfileDecoration;
  const existingData = (existing.cosmetic.data ?? {}) as {
    offsets?: CosmeticOffsets;
  } & Record<string, unknown>;
  const offsetsChange = isDecoration && offsets !== undefined;
  if (offsetsChange && offsets && !isModerator) assertCreatorOffsets(offsets, existingData.offsets);
  const nextOffsets = !isDecoration
    ? null
    : offsets === undefined
    ? existingData.offsets ?? null
    : offsets;

  // Slug rules are Sticker-only — the schema accepts `slug` on any type, so
  // without this gate a crafted request would hit them on a Badge.
  const isStickerItem = existing.cosmetic.type === CosmeticType.Sticker;
  const existingSlug = (existing.cosmetic.data as { slug?: string } | null)?.slug;
  const requestedSlug = isStickerItem ? slug?.trim().toLowerCase() : undefined;
  // Rebuilding `data` from scratch would drop the slug on an artwork swap, and
  // owners' `:slug:` text depends on it — so carry the existing one forward.
  const nextSlug = requestedSlug ?? existingSlug;
  const slugChange = requestedSlug !== undefined && requestedSlug !== existingSlug;
  // Same carry-forward reasoning as the slug: rebuilding `data` would drop the
  // economics, and buyers' balances and top-ups were priced by them. Read as one
  // object so a field added later is carried without a new call site to update.
  const existingEconomics = stickerEconomicsFromCosmeticData(existing.cosmetic.data);
  const requestedUses = isStickerItem ? uses : undefined;
  const requestedPricePerUse = isStickerItem ? pricePerUse : undefined;
  const nextEconomics: StickerEconomics = {
    ...existingEconomics,
    ...(requestedUses !== undefined ? { uses: requestedUses } : {}),
    ...(requestedPricePerUse !== undefined ? { pricePerUse: requestedPricePerUse } : {}),
  };
  const nextUses = nextEconomics.uses;
  const usesChange = requestedUses !== undefined && requestedUses !== existingEconomics.uses;
  const pricePerUseChange =
    requestedPricePerUse !== undefined && requestedPricePerUse !== existingEconomics.pricePerUse;
  const economicsChange = usesChange || pricePerUseChange;

  // Cross-listings point at another creator's shared cosmetic — the seller may
  // never touch its art/name/description/payment terms, only price & quantity.
  // The slug belongs to the original creator too: a reseller renaming it would
  // break every owner's typed `:slug:` on someone else's cosmetic.
  const isOriginalCreator = isModerator || existing.cosmetic.createdById === userId;
  if (
    !isOriginalCreator &&
    (name !== undefined ||
      description !== undefined ||
      imageUrl !== undefined ||
      acceptsBlueBuzz !== undefined ||
      sellableByOthers !== undefined ||
      sellerShare !== undefined ||
      offsetsChange ||
      slugChange ||
      economicsChange)
  )
    throw throwBadRequestError(
      "You can only change price and quantity for another creator's cosmetic"
    );

  if (price != null) {
    const priceFloor = cosmeticPriceFloor(existing.cosmetic.type);
    if (price < priceFloor)
      throw throwBadRequestError(
        `This cosmetic type must be listed for at least ${priceFloor} Buzz`
      );
  }
  // Re-check the per-use floor whenever either side of it moves.
  const effectivePrice = price ?? existing.unitAmount;
  if (nextUses && effectivePrice < nextUses * STICKER_MIN_BUZZ_PER_USE)
    throw throwBadRequestError(
      `${nextUses} uses needs at least ${
        nextUses * STICKER_MIN_BUZZ_PER_USE
      } Buzz (${STICKER_MIN_BUZZ_PER_USE} per use)`
    );
  const perUseFloor = stickerPerUseFloor(existing.cosmetic.type);
  if (nextEconomics.pricePerUse && nextEconomics.pricePerUse < perUseFloor)
    throw throwBadRequestError(`A single use must cost at least ${perUseFloor} Buzz`);

  const isPublished = existing.status === CosmeticShopItemStatus.Published;
  const artChanged = imageUrl !== undefined;
  // A live item may already have buyers — creators may only change price &
  // quantity, but moderators can fix name/description/fit post-publish (the
  // edit stays live; it does not re-enter review).
  if (
    isPublished &&
    !isModerator &&
    (name !== undefined || description !== undefined || artChanged || offsetsChange)
  )
    throw throwBadRequestError('Published items can only change price and quantity');
  // The slug is the token owners type, not metadata. Renaming it breaks every
  // owner's muscle memory and their picker search, while already-sent messages
  // keep working off the id — so the creator gets no signal they broke anything.
  // Mods can still fix a genuine typo.
  if (isPublished && !isModerator && slugChange)
    throw throwBadRequestError('The sticker slug cannot be changed once published');
  // Buyers already have the art — it can't change once sold.
  if (artChanged && existing._count.purchases > 0)
    throw throwBadRequestError('Artwork cannot be changed once an item has sold');
  // The stored affirmation covers the art it was made against, so swapping the
  // art needs a fresh one. A moderator swapping art isn't claiming any rights of
  // their own, so they neither affirm nor overwrite the creator's record.
  const requiresAffirmation = artChanged && !isModerator;
  if (requiresAffirmation && !rightsAffirmed)
    throw throwBadRequestError('You must confirm you have the rights to sell this artwork');

  if (slugChange)
    await validateStickerCosmetic({
      id: existing.cosmetic.id,
      type: existing.cosmetic.type,
      data: { slug: nextSlug },
    });

  // Validate + build replaced artwork server-side.
  let artwork:
    | {
        data: Prisma.InputJsonValue;
        checks: AutoCheck[];
        imageMeta: CosmeticImageMeta;
        imageHash: string;
      }
    | undefined;
  if (artChanged && imageUrl) {
    const { checks, imageMeta, imageHash, allPassed } = await validateArtwork(
      imageUrl,
      existing.cosmetic.type
    );
    if (!allPassed)
      throw throwBadRequestError('Artwork does not meet the requirements for this cosmetic type');
    await assertClientImageUrlsUsable({
      urls: [imageUrl],
      userId: existing.cosmetic.createdById ?? userId,
      shopRow: { cosmeticId: existing.cosmeticId },
    });
    await assertShopArtworkKeysIssued({
      urls: [imageUrl],
      userId,
      alsoIssuedTo: isModerator ? existing.cosmetic.createdById ?? undefined : undefined,
    });
    if (await findDuplicateArtwork(imageHash, id))
      throw throwBadRequestError('This artwork has already been submitted to the shop.');
    checks.push({ key: 'duplicate', label: 'Original artwork', passed: true });
    artwork = {
      // The economics matter here: replacing artwork REBUILDS `data` rather than
      // patching it (patchCosmeticData returns artworkData wholesale), so
      // omitting uses silently turned a finite sticker into an unlimited one for
      // every future buyer.
      data: buildCosmeticData(
        existing.cosmetic.type,
        imageUrl,
        animated,
        nextOffsets,
        nextSlug,
        nextEconomics
      ) as Prisma.InputJsonValue,
      checks,
      imageMeta,
      imageHash,
    };
  }

  const contentChanged =
    name !== undefined ||
    description !== undefined ||
    artChanged ||
    offsetsChange ||
    slugChange ||
    economicsChange;
  const meta = (existing.meta ?? {}) as CosmeticShopItemMeta;
  const base = meta.lastApprovedAmount ?? existing.unitAmount;
  const bigPriceChange =
    price != null && base > 0 && Math.abs(price - base) / base > PRICE_REVIEW_THRESHOLD;

  // Resale terms are an offer to future resellers, not a term of anyone's
  // existing listing — those carry their own `sellerShare` on the resale row, so
  // nothing here can reach a creator who already listed the item.
  const resaleChanged = sellableByOthers !== undefined || sellerShare !== undefined;
  const nextSellableByOthers = sellableByOthers ?? meta.sellableByOthers ?? false;
  // Mirrors submit: an item nobody may resell carries no share, so switching
  // resale off and back on can't quietly restore an old number.
  const nextSellerShare = nextSellableByOthers ? sellerShare ?? meta.sellerShare ?? 0 : 0;

  // Published re-enters review only on a >±25% price change (a small tweak stays
  // live). RequestedChanges & PendingReview edits (re)enter the queue.
  const backToReview =
    (isPublished && bigPriceChange) ||
    existing.status === CosmeticShopItemStatus.RequestedChanges ||
    existing.status === CosmeticShopItemStatus.PendingReview;
  const status = backToReview ? CosmeticShopItemStatus.PendingReview : existing.status;
  // A capped item would stay in a live pack while failing the pack rules. A repriced one is fine:
  // the pack keeps the value it was approved at.
  if (!isModerator && existing.addedById != null && availableQuantity != null)
    await assertNotInLiveMysteryPack({
      cosmeticId: existing.cosmeticId,
      sellerId: existing.addedById,
    });

  const changes: CosmeticShopItemHistoryChange[] = [];
  const recordChange = (
    field: string,
    from: string | number | null | undefined,
    to: string | number | null | undefined
  ) => {
    if (from !== to) changes.push({ field, from, to });
  };
  if (name !== undefined) recordChange('name', existing.title, name);
  if (description !== undefined) recordChange('description', existing.description, description);
  // The pre-swap url, captured before `data` is rebuilt — it's the only way the
  // queue can show what the artwork used to be.
  if (artChanged) recordChange('artwork', existingData.url as string | undefined, imageUrl);
  if (offsetsChange)
    recordChange('offsets', offsetsLabel(existingData.offsets), offsetsLabel(nextOffsets));
  if (slugChange) recordChange('slug', existingSlug, nextSlug);
  if (usesChange) recordChange('uses', existingEconomics.uses, nextEconomics.uses);
  if (pricePerUseChange)
    recordChange('pricePerUse', existingEconomics.pricePerUse, nextEconomics.pricePerUse);
  if (price != null) recordChange('price', existing.unitAmount, price);
  if (availableQuantity !== undefined)
    recordChange('quantity', existing.availableQuantity, availableQuantity);
  const yesNo = (value?: boolean) => (value ? 'yes' : 'no');
  if (acceptsBlueBuzz !== undefined)
    recordChange('acceptsBlueBuzz', yesNo(meta.acceptsBlueBuzz), yesNo(acceptsBlueBuzz));
  if (resaleChanged) {
    recordChange('sellableByOthers', yesNo(meta.sellableByOthers), yesNo(nextSellableByOthers));
    recordChange('sellerShare', meta.sellerShare ?? 0, nextSellerShare);
  }

  const reviewNote = !backToReview
    ? undefined
    : isPublished
    ? `Returned to review: price moved more than ${Math.round(
        PRICE_REVIEW_THRESHOLD * 100
      )}% from the approved ${base} Buzz`
    : existing.status === CosmeticShopItemStatus.RequestedChanges
    ? 'Resubmitted for review after requested changes'
    : 'Edited while awaiting review';

  const patchedData = !contentChanged
    ? undefined
    : (patchCosmeticData({
        existingData,
        artworkData: artwork?.data as Record<string, unknown> | undefined,
        offsetsChange,
        slugChange,
        economicsChange,
        nextOffsets,
        nextSlug,
        nextEconomics,
      }) as Prisma.InputJsonValue | undefined);

  const updatedMeta: CosmeticShopItemMeta = {
    ...meta,
    ...(acceptsBlueBuzz !== undefined ? { acceptsBlueBuzz } : {}),
    ...(resaleChanged
      ? { sellableByOthers: nextSellableByOthers, sellerShare: nextSellerShare }
      : {}),
    ...(artwork
      ? {
          autoChecks: artwork.checks,
          imageMeta: artwork.imageMeta,
          imageHash: artwork.imageHash,
        }
      : {}),
    ...(requiresAffirmation ? { rightsAffirmation: buildRightsAffirmation(userId) } : {}),
    displayApproved:
      !isModerator && changesDisplay(changes)
        ? false
        : recordedDisplayVerdict({
            status: existing.status,
            meta,
            rejectionReason: existing.rejectionReason,
          }),
  };
  // An edit that moved nothing (e.g. a resubmit with identical values) isn't
  // worth a row in the history.
  const nextMeta = changes.length
    ? appendItemHistory(updatedMeta, {
        at: new Date().toISOString(),
        userId,
        kind: 'edited',
        status,
        note: reviewNote,
        changes,
      })
    : updatedMeta;

  const cosmeticId = existing.cosmeticId;
  const updated = await dbWrite.$transaction(async (tx) => {
    // Everything above was derived from `existing`: a verdict committed since the read would be
    // erased with its history entry and `displayApproved`.
    const current = await lockShopItem(tx, id);
    // Every sale bumps `purchases` in SQL (countShopItemSale): carried from the locked row, not
    // compared, so a sale mid-edit is neither a conflict nor rolled back by this write.
    const { purchases, ...currentMeta } = (current.meta ?? {}) as CosmeticShopItemMeta;
    const { purchases: _readPurchases, ...readMeta } = meta;
    if (current.status !== existing.status || !isEqual(currentMeta, readMeta))
      throw throwConflictError(
        'This item changed while you were editing it. Reload and try again.'
      );

    if (contentChanged)
      await tx.cosmetic.update({
        where: { id: cosmeticId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(patchedData !== undefined ? { data: patchedData } : {}),
        },
      });
    return tx.cosmeticShopItem.update({
      where: { id },
      data: {
        ...(name !== undefined ? { title: name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(price != null ? { unitAmount: price } : {}),
        ...(availableQuantity !== undefined ? { availableQuantity } : {}),
        status,
        // Clear the prior verdict whenever it re-enters the review queue.
        ...(backToReview ? { rejectionReason: null, reviewedById: null, reviewedAt: null } : {}),
        meta: {
          ...nextMeta,
          ...(purchases !== undefined ? { purchases } : {}),
        } as Prisma.InputJsonValue,
      },
      select: creatorShopItemSelect,
    });
  });
  // A raw update replaces `data.url` without going near updateCosmetic, so
  // nothing else re-hashes it: the old hash survives against new artwork and
  // `pHashUrl` is what tells the two apart afterwards.
  if (artChanged && imageUrl) queueCosmeticPerceptualHash({ id: cosmeticId, url: imageUrl });
  await unequipWithheldCosmetic(cosmeticId);
  return updated;
};

/**
 * Withdrawing an item from sale ends every resale listing of it, and tells the
 * creators who were selling it. They are not left with a dead card, and — since
 * the listing carried the share they were promised — they don't silently keep a
 * claim to terms on an item that no longer sells.
 *
 * Coming back is deliberately not the mirror image of this: re-listing re-enters
 * review (see `setCreatorShopItemListed` / `unarchiveCreatorShopItem`), so the
 * withdraw → re-list cycle can't be used as a cheap way to clear your resellers
 * and re-offer the item on worse terms.
 */
const endResaleListings = async ({ shopItemId, title }: { shopItemId: number; title: string }) => {
  const listings = await dbRead.userCosmeticShopItemResale.findMany({
    where: { shopItemId },
    select: { userId: true, user: { select: { username: true } } },
  });
  await dbWrite.userCosmeticShopItemResale.deleteMany({ where: { shopItemId } });
  if (!listings.length) return;

  const at = Date.now();
  // The listings are already gone; failing the withdrawal over an undelivered
  // notification would leave the creator unable to retry it, and one bad row
  // shouldn't cost the other resellers their notice either.
  const results = await Promise.allSettled(
    listings.map(({ userId, user }) =>
      createNotification({
        type: 'creator-shop-resale-ended',
        userId,
        category: NotificationCategory.System,
        // Stamped: an item can be withdrawn, brought back, and withdrawn again.
        key: `creator-shop-resale-ended:${shopItemId}:${userId}:${at}`,
        details: { title, username: user.username ?? undefined },
      })
    )
  );
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length)
    logToAxiom({
      level: 'error',
      message: 'Failed to notify resellers of a withdrawn shop item',
      data: {
        shopItemId,
        failed: failures.length,
        total: results.length,
        errors: failures.map((f) => f.reason),
      },
    });
};

// The verdict or archive has landed whatever happens here; `sweepWithdrawnShopRefunds` finishes it.
// Bounded, so the request does not wait on an item with hundreds of sales.
const startWithdrawnRefund = (shopItemId: number) =>
  refundWithdrawnShopItem(shopItemId, { limit: 25 }).catch((error) =>
    logToAxiom({
      level: 'error',
      name: 'creator-shop-withdrawn-refund',
      message: 'Withdrawn refund failed; the job retries it',
      data: { shopItemId, error: error instanceof Error ? error.message : String(error) },
    }).catch(() => undefined)
  );

export const archiveCreatorShopItem = async ({
  userId,
  isModerator,
  id,
}: {
  userId: number;
  isModerator?: boolean;
  id: number;
}) => {
  const existing = await getOwnedItemOrThrow(id, userId, isModerator);
  // A creator's mystery pack has its own withdraw, which keeps its review and live count in step.
  if (!isModerator && existing.itemDefinitionId != null)
    throw throwBadRequestError('Withdraw a mystery pack instead of archiving its listing');
  if (!isModerator && existing.cosmeticId != null && existing.addedById != null)
    await assertNotInLiveMysteryPack({
      cosmeticId: existing.cosmeticId,
      sellerId: existing.addedById,
    });
  const now = new Date();
  const { updated, withheld } = await dbWrite.$transaction(async (tx) => {
    const current = await lockShopItem(tx, id);
    if (current.status === CosmeticShopItemStatus.Archived)
      throw throwBadRequestError('Item is already archived');
    // Archiving is how a rejection used to be laundered: Archived overwrites the
    // status, and restoring re-enters review with the verdict cleared.
    if (current.status === CosmeticShopItemStatus.Rejected)
      throw throwBadRequestError(REJECTED_IS_FINAL);
    // Archiving an item its buyers can't wear ends any chance of it coming back for them, so they
    // are refunded and the creator pays: payouts are reversed even into a negative balance.
    const meta = (current.meta ?? {}) as CosmeticShopItemMeta;
    const withheld =
      existing.cosmeticId != null &&
      !isListingDisplayable({
        status: current.status,
        meta,
        rejectionReason: current.rejectionReason,
      });
    const updated = await tx.cosmeticShopItem.update({
      where: { id },
      data: {
        status: CosmeticShopItemStatus.Archived,
        archivedAt: now,
        ...(withheld
          ? {
              meta: {
                ...meta,
                withdrawnRefund: {
                  trigger: 'archive',
                  clawback: true,
                  userId,
                  at: now.toISOString(),
                },
              } as Prisma.InputJsonValue,
            }
          : {}),
      },
      select: creatorShopItemSelect,
    });
    return { updated, withheld };
  });
  if (withheld) await startWithdrawnRefund(id);

  await endResaleListings({ shopItemId: id, title: existing.title });

  // D14: withdrawing a cosmetic delists every pack that bundles it. `listed`,
  // not Archived, so the pack's creator can swap the member out and relist.
  if (existing.cosmeticId != null) await delistPacksContaining(existing.cosmeticId);

  // An archived item can't be featured — free up its featured slot (owner must
  // re-feature it after unarchiving).
  if (existing.addedById) {
    const settings = await getCreatorShopSettings({ userId: existing.addedById });
    const featuredItemIds = settings.featuredItemIds ?? [];
    if (featuredItemIds.includes(id))
      await updateCreatorShopSettings({
        userId: existing.addedById,
        featuredItemIds: featuredItemIds.filter((fid) => fid !== id),
      });
  }

  return updated;
};

/**
 * Delisting withdraws an item from individual sale while leaving it Published,
 * so other creators can still bundle it. Archiving removes it from both. Either
 * way the item's resale listings end.
 *
 * Coming back is not free: re-listing re-enters review rather than going
 * straight back on sale. Without that, withdraw → re-list would be a one-click
 * way to clear every reseller and re-offer the item at a worse share, which is
 * exactly the bait-and-switch grandfathering exists to prevent.
 */
export const setCreatorShopItemListed = async ({
  userId,
  isModerator,
  id,
  listed,
}: {
  userId: number;
  isModerator?: boolean;
  id: number;
  listed: boolean;
}) => {
  const existing = await getOwnedItemOrThrow(id, userId, isModerator);
  // The storefront would show it as a pack; a box is sold only through its own surface.
  if (existing.itemDefinitionId != null)
    throw throwBadRequestError('Mystery box listings stay unlisted');

  const updated = await dbWrite.$transaction(async (tx) => {
    const current = await lockShopItem(tx, id);
    if (current.status === CosmeticShopItemStatus.Archived)
      throw throwBadRequestError('Restore this item before changing its listing');
    // Listing resets an item to PendingReview and clears the verdict, so without
    // this a rejected item is one call away from being back in the queue unedited.
    if (current.status === CosmeticShopItemStatus.Rejected)
      throw throwBadRequestError(REJECTED_IS_FINAL);
    const meta = current.meta as CosmeticShopItemMeta | null;
    return tx.cosmeticShopItem.update({
      where: { id },
      data: {
        listed,
        ...(listed
          ? {
              status: CosmeticShopItemStatus.PendingReview,
              rejectionReason: null,
              reviewedById: null,
              reviewedAt: null,
              meta: {
                ...meta,
                displayApproved: recordedDisplayVerdict({
                  status: current.status,
                  meta,
                  rejectionReason: current.rejectionReason,
                }),
              } as Prisma.InputJsonValue,
            }
          : {}),
      },
      select: creatorShopItemSelect,
    });
  });

  if (!listed) await endResaleListings({ shopItemId: id, title: existing.title });

  // A delisted item can't sit in a featured slot, same as an archived one.
  if (!listed && existing.addedById) {
    const settings = await getCreatorShopSettings({ userId: existing.addedById });
    const featuredItemIds = settings.featuredItemIds ?? [];
    if (featuredItemIds.includes(id))
      await updateCreatorShopSettings({
        userId: existing.addedById,
        featuredItemIds: featuredItemIds.filter((fid) => fid !== id),
      });
  }

  return updated;
};

export const unarchiveCreatorShopItem = async ({
  userId,
  isModerator,
  id,
}: {
  userId: number;
  isModerator?: boolean;
  id: number;
}) => {
  const existing = await getOwnedItemOrThrow(id, userId, isModerator);
  if (!isModerator && existing.itemDefinitionId != null)
    throw throwBadRequestError("A withdrawn mystery pack can't be restored");
  return dbWrite.$transaction(async (tx) => {
    const current = await lockShopItem(tx, id);
    if (current.status !== CosmeticShopItemStatus.Archived)
      throw throwBadRequestError('Only archived items can be restored');
    // `preArchiveStatus` is a leftover from when restoring returned an item to
    // where it was; it now re-enters review either way, so drop any stored value.
    // A refund owed for the archive stops here: buyers whose refund had not begun keep the cosmetic.
    const { preArchiveStatus, withdrawnRefund, ...meta } = (current.meta ??
      {}) as CosmeticShopItemMeta & {
      preArchiveStatus?: CosmeticShopItemStatus;
    };
    if (meta.takedown)
      throw throwBadRequestError('This item was taken down and cannot be restored to sale');
    // Items archived while rejected predate the block on archiving them, and restoring one would
    // clear its verdict. Refund history entries only follow newer archives, so on those older items
    // a recorded verdict is still the last one and cannot have aged out of the cap.
    //
    // An item old enough to have no history at all leaves only `rejectionReason`,
    // which a change request sets too. That is not enough to convict, so it is
    // refused for the creator (who must never be able to resubmit a rejection) and
    // left to a moderator, who can read the reason and decide.
    const rejectionUnprovable = !meta.history?.length && !!current.rejectionReason;
    if (wasLastReviewARejection(meta.history) || (rejectionUnprovable && !isModerator))
      throw throwBadRequestError(REJECTED_IS_FINAL);
    return tx.cosmeticShopItem.update({
      where: { id },
      data: {
        // Same rule as re-listing: archiving ended this item's resale listings, so
        // bringing it back is a fresh submission, not an undo.
        status: CosmeticShopItemStatus.PendingReview,
        archivedAt: null,
        rejectionReason: null,
        reviewedById: null,
        reviewedAt: null,
        meta: {
          ...meta,
          displayApproved: recordedDisplayVerdict({
            status: current.status,
            meta,
            rejectionReason: current.rejectionReason,
          }),
        } as Prisma.InputJsonValue,
      },
      select: creatorShopItemSelect,
    });
  });
};

export const deleteCreatorShopItem = async ({
  userId,
  isModerator,
  id,
}: {
  userId: number;
  isModerator?: boolean;
  id: number;
}) => {
  // Deleting wipes purchase records — a moderator-only action; creators archive.
  if (!isModerator) throw throwAuthorizationError('Only moderators can delete shop items');
  const existing = await getOwnedItemOrThrow(id, userId, isModerator);
  // The box, its pending edit and any boxes buyers hold would outlive the listing.
  if (existing.itemDefinitionId != null)
    throw throwBadRequestError(
      "A mystery pack's listing can't be deleted: reject or revert the pack"
    );
  // The creator's own listing is what withholds its cosmetic, so a withheld one leaves that on the
  // cosmetic before it goes; holders of an approved one keep wearing it.
  const keepWithheld =
    existing.cosmeticId != null &&
    existing.cosmetic?.createdById != null &&
    existing.addedById === existing.cosmetic.createdById &&
    !isListingDisplayable({
      status: existing.status,
      meta: existing.meta as CosmeticShopItemMeta | null,
      rejectionReason: existing.rejectionReason,
    });
  if (keepWithheld)
    await dbWrite.$executeRaw`
      UPDATE "Cosmetic" SET flags = flags | ${CosmeticFlag.Withheld}::int WHERE id = ${existing.cosmeticId}::int
    `;
  // Hard delete. FK cascades wipe the purchase records (sales totals), any
  // official-shop section links, and other creators' resale listings. Buyers
  // keep what they bought: UserCosmetic is keyed by cosmeticId and the Cosmetic
  // row is intentionally left in place.
  await dbWrite.$transaction(async (tx) => {
    await tx.cosmeticShopItem.delete({ where: { id } });
    await excludeDeletedShopListing(tx, id);
  }, SHOP_VERDICT_TRANSACTION);
  if (keepWithheld) await unequipWithheldCosmetic(existing.cosmeticId);

  // Free its featured slot.
  if (existing.addedById) {
    const settings = await getCreatorShopSettings({ userId: existing.addedById });
    const featuredItemIds = settings.featuredItemIds ?? [];
    if (featuredItemIds.includes(id))
      await updateCreatorShopSettings({
        userId: existing.addedById,
        featuredItemIds: featuredItemIds.filter((fid) => fid !== id),
      });
  }

  return { id, purchases: existing._count.purchases };
};

// A creator's own items (any status) for the "Manage your shop" view. The router
// only lets a moderator pass someone else's userId.
export const getCreatorShopManageItems = async ({ userId }: { userId: number }) => {
  const items = await dbRead.cosmeticShopItem.findMany({
    // Mystery box listings are managed with their box, not as a shop item.
    where: { addedById: userId, itemDefinitionId: null },
    // The reseller count tells the creator what's at stake before they touch the
    // item's resale terms — existing resellers keep the ones they listed under.
    // Deleted accounts are filtered out to match `getShopItemResellers`, or the
    // count disagrees with the list the creator opens from it.
    select: {
      ...creatorShopItemSelect,
      _count: { select: { resales: { where: { user: { deletedAt: null } } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const sold = await getSoldCounts(items.map((i) => i.id));
  return items.map(({ _count, ...item }) => ({
    ...withRemaining(item, sold.get(item.id) ?? 0),
    resellerCount: _count.resales,
  }));
};

// ---------------------------------------------------------------------------
// Public: creator storefront
// ---------------------------------------------------------------------------

/**
 * Owners and moderators always see a shop; a private shop, or a block either way, is NotFound to
 * others. Returns the viewer's blocked-pair ids, which the storefront also filters resales by.
 */
export async function assertCreatorShopVisible({
  userId,
  viewerId,
  isModerator,
  settings,
}: {
  userId: number;
  viewerId?: number;
  isModerator?: boolean;
  settings?: CreatorShopSettings;
}): Promise<number[]> {
  if (viewerId === userId || isModerator) return [];
  const { enabled } = settings ?? (await getCreatorShopSettings({ userId }));
  if (enabled !== true) throw throwNotFoundError('Shop not found');
  // Same NotFound as a private shop so the block isn't revealed.
  const viewerPairIds = viewerId ? await getBlockedPairIds(viewerId) : [];
  if (viewerPairIds.includes(userId)) throw throwNotFoundError('Shop not found');
  return viewerPairIds;
}

export const getCreatorShop = async ({
  userId,
  viewerId,
  stickersEnabled,
  packsEnabled,
  isModerator,
  preview,
}: {
  userId: number;
  viewerId?: number;
  stickersEnabled?: boolean;
  packsEnabled?: boolean;
  isModerator?: boolean;
  // Moderator-only design aid: ignore this creator's own inventory/config and
  // fill every section with real site-wide sample data (see the router — only
  // honored for mods).
  preview?: boolean;
}) => {
  const settings = await getCreatorShopSettings({ userId });
  const viewerPairIds = preview
    ? []
    : await assertCreatorShopVisible({ userId, viewerId, isModerator, settings });

  const now = new Date();
  // The resale rows ARE the permission and the terms: a listing survives its
  // creator switching resale back off, and carries the share it was made under.
  const resales = preview
    ? []
    : await dbRead.userCosmeticShopItemResale.findMany({
        where: { userId },
        orderBy: [{ index: 'asc' }, { shopItemId: 'asc' }],
        select: { shopItemId: true, sellerShare: true },
      });
  const resoldIds = resales.map((r) => r.shopItemId);
  const resaleShares = new Map(resales.map((r) => [r.shopItemId, r.sellerShare]));
  // Blocks remove a resold item from the storefront: owner↔item-creator (the
  // block forbids the resale pairing; the owner still sees it in their manage
  // list so they can remove it) and viewer↔item-creator (a creator who blocked
  // the viewer shouldn't surface in any shop the viewer browses).
  const blockedPairIds = preview
    ? []
    : [...new Set([...(await getBlockedPairIds(userId)), ...viewerPairIds])];
  const [items, resoldItems, earlyAccessModelCount] = await Promise.all([
    dbRead.cosmeticShopItem.findMany({
      where: {
        status: CosmeticShopItemStatus.Published,
        listed: true,
        ...hideStickers(stickersEnabled, packsEnabled),
        // Preview draws cosmetics from every creator so the section is populated
        // regardless of whose (possibly empty) shop is being viewed.
        ...(preview ? {} : { addedById: userId }),
        AND: [
          { OR: [{ availableFrom: null }, { availableFrom: { lte: now } }] },
          { OR: [{ availableTo: null }, { availableTo: { gte: now } }] },
        ],
      },
      // Reuse the official shop's selector (+ creator) so cards render with the
      // exact same <ShopItem> component + purchase modal as /shop.
      select: creatorStorefrontItemSelect,
      orderBy: { createdAt: 'desc' },
      ...(preview ? { take: 12 } : {}),
    }),
    // Resold items reference other creators' still-sellable published items —
    // one inventory, owned by the original creator (no copy). Preview shows a
    // sample of any sellable items instead of this creator's chosen list.
    dbRead.cosmeticShopItem.findMany({
      where: {
        ...(preview ? {} : { id: { in: resoldIds } }),
        status: CosmeticShopItemStatus.Published,
        // Withdrawing an item ends its resale listings outright (see
        // `endResaleListings`), so a delisted one has nothing left to show.
        listed: true,
        ...hideStickers(stickersEnabled, packsEnabled),
        // Preview has no resale rows to draw on, so it falls back to any item
        // currently on offer for resale.
        ...(preview ? { meta: { path: ['sellableByOthers'], equals: true } } : {}),
        // Hide resold items whose owner has since made their shop private.
        addedBy: { settings: { path: ['creatorShop', 'enabled'], equals: true } },
        ...(blockedPairIds.length ? { addedById: { notIn: blockedPairIds } } : {}),
      },
      select: creatorStorefrontItemSelect,
      ...(preview ? { take: 6, orderBy: { id: 'desc' } } : {}),
    }),
    // Drives the Models section visibility — the storefront only lists the
    // creator's currently-Early-Access models (paid tiers come later). Preview
    // counts site-wide so the Models section always renders.
    dbRead.$queryRaw<{ count: number }[]>`
      SELECT COUNT(DISTINCT m.id)::int AS count
      FROM "Model" m
      JOIN "ModelVersion" mv ON mv."modelId" = m.id
      JOIN "PaidAccess" pa ON pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id
      WHERE m.status = 'Published'::"ModelStatus" AND m."deletedAt" IS NULL
        AND mv.status = 'Published'::"ModelStatus"
        AND pa."endsAt" > NOW()
        ${preview ? Prisma.empty : Prisma.sql`AND m."userId" = ${userId}`}
    `.then((r) => r[0]?.count ?? 0),
  ]);

  const sold = await getSoldCounts([...items, ...resoldItems].map((i) => i.id));

  // Sanitize meta to what the card/checkout needs — never the creator
  // payout/fee internals.
  const sanitize = (item: (typeof items)[number]) => ({
    ...item,
    meta: shopItemDisplayMeta(item.meta as CosmeticShopItemMeta | null, sold.get(item.id) ?? 0),
  });
  const cosmetics = items.map(sanitize);
  // Resold items keep the seller share so the buyer can see the split at
  // checkout — the listing's own, so it matches what the payout will pay.
  const sanitizeResold = (item: (typeof resoldItems)[number]) => ({
    ...item,
    meta: {
      ...shopItemDisplayMeta(item.meta as CosmeticShopItemMeta | null, sold.get(item.id) ?? 0),
      sellerShare:
        resaleShares.get(item.id) ?? (item.meta as CosmeticShopItemMeta)?.sellerShare ?? 0,
    },
  });
  const resold = preview
    ? resoldItems.map(sanitizeResold)
    : // Preserve the creator's chosen resold order.
      (() => {
        const resoldById = new Map(resoldItems.map((i) => [i.id, sanitizeResold(i)]));
        return resoldIds
          .map((id) => resoldById.get(id))
          .filter((x): x is ReturnType<typeof sanitizeResold> => !!x);
      })();
  const featured = preview
    ? cosmetics.slice(0, 3)
    : (settings.featuredItemIds ?? [])
        .map((fid) => cosmetics.find((c) => c.id === fid))
        .filter((x): x is (typeof cosmetics)[number] => !!x);

  // In preview, force every section on so the layout is fully exercised.
  const effectiveSettings = preview
    ? { ...settings, enabled: true, showModels: true, sections: undefined }
    : settings;

  return {
    cosmetics,
    featured,
    resold,
    settings: effectiveSettings,
    earlyAccessModelCount,
  };
};

/**
 * Order for the community hub.
 *
 * "Newest" reads `reviewedAt` (when a moderator approved the item), not
 * `createdAt`/`id` (when the creator submitted it) — otherwise an item that sat
 * a week in the review queue would publish already buried under everything
 * submitted while it waited. `id` breaks every tie so a page boundary can't
 * drop or repeat a row. Rows with no `reviewedAt` (published without ever
 * passing through review) sort as the oldest in both directions.
 */
const communityCosmeticsOrderBy = (
  sort: CosmeticShopSort
): Prisma.CosmeticShopItemOrderByWithRelationInput[] => {
  switch (sort) {
    case CosmeticShopSort.Oldest:
      return [{ reviewedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }];
    case CosmeticShopSort.PriceLowToHigh:
      return [{ unitAmount: 'asc' }, { id: 'desc' }];
    case CosmeticShopSort.PriceHighToLow:
      return [{ unitAmount: 'desc' }, { id: 'desc' }];
    case CosmeticShopSort.MostPopular:
      // The purchase rows, not `meta.purchases` — a JSON counter can't be
      // ordered on, and the rows are what a refund/takedown actually removes.
      return [{ purchases: { _count: 'desc' } }, { id: 'desc' }];
    case CosmeticShopSort.Name:
      return [{ title: 'asc' }, { id: 'desc' }];
    case CosmeticShopSort.Newest:
    default:
      return [{ reviewedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
  }
};

// Site-wide hub of every published community cosmetic (creator-submitted items
// from public shops). Powers the /shop marketplace section.
export const getCommunityCosmetics = async ({
  viewerId,
  limit,
  page,
  cosmeticTypes,
  sort,
  wishlisted,
  owned,
  limited,
  acceptsBlueBuzz,
  query,
  stickersEnabled,
  packsEnabled,
}: GetCommunityCosmeticsInput & {
  viewerId?: number;
  stickersEnabled?: boolean;
  packsEnabled?: boolean;
}) => {
  const now = new Date();
  // A block between viewer and a cosmetic's creator (either direction) hides
  // that creator's items from the feed.
  const blockedPairIds = viewerId ? await getBlockedPairIds(viewerId) : [];
  const { take, skip } = getPagination(limit, page);
  // 'Pack' rides in the same filter but is not a CosmeticType.
  const realTypes = (cosmeticTypes ?? []).filter((t): t is CosmeticType => t !== PACK_FILTER_VALUE);
  // Slugs are validated lowercase, so the JSON match can stay case-sensitive.
  const slugTerm = query ? stickerSlugSearchTerm(query) : undefined;
  const where: Prisma.CosmeticShopItemWhereInput = {
    status: CosmeticShopItemStatus.Published,
    // Discovery surface that leads straight to checkout — a delisted item
    // here would be a dead end.
    listed: true,
    // Creator-submitted only (official cosmetics have no creator). Blocks
    // filter both the original creator and the lister — they can differ on
    // cross-listed items.
    //
    // A pack is creator-submitted too, just via `addedById`, and a `cosmetic`
    // relation filter is an EXISTS that would drop every one of them. This is
    // the only site-wide discovery surface, so packs belong in it. A type
    // filter still excludes them: a pack has no type to match.
    OR: [
      // Packs show when nothing is filtered, or when the Pack chip is on.
      ...(packsEnabled && (!cosmeticTypes?.length || cosmeticTypes.includes(PACK_FILTER_VALUE))
        ? [PACK_SHOP_ITEM_WHERE]
        : []),
      ...(cosmeticTypes?.length && !realTypes.length
        ? []
        : [
            {
              cosmetic: {
                createdById: {
                  not: null,
                  ...(blockedPairIds.length ? { notIn: blockedPairIds } : {}),
                },
                // Merged into one `type` filter: a second `type` key would silently
                // overwrite the caller's requested types.
                ...(realTypes.length || !stickersEnabled
                  ? {
                      type: {
                        ...(realTypes.length ? { in: realTypes } : {}),
                        ...(stickersEnabled ? {} : { not: CosmeticType.Sticker }),
                      },
                    }
                  : {}),
              },
            },
          ]),
    ],
    // Only items whose owner's shop is public.
    addedBy: { settings: { path: ['creatorShop', 'enabled'], equals: true } },
    ...(blockedPairIds.length ? { addedById: { notIn: blockedPairIds } } : {}),
    ...(viewerId && wishlisted ? { wishlists: { some: { userId: viewerId } } } : {}),
    ...(acceptsBlueBuzz ? { meta: { path: ['acceptsBlueBuzz'], equals: true } } : {}),
    AND: [
      { OR: [{ availableFrom: null }, { availableFrom: { lte: now } }] },
      { OR: [{ availableTo: null }, { availableTo: { gte: now } }] },
      ...(limited
        ? [{ OR: [{ availableQuantity: { not: null } }, { availableTo: { not: null } }] }]
        : []),
      // Content decorations stay in a "not owned" view: owning one doesn't stop
      // you buying another, which is also why the card never marks them owned.
      // `browseShopItems` applies the same rule to the client-paged surfaces.
      // Packs have no single cosmetic to own, so neither modifier speaks to
      // them — they'd otherwise vanish from "not owned" via the EXISTS.
      ...(viewerId && owned === 'notOwned'
        ? [
            {
              OR: [
                { cosmeticId: null },
                { cosmetic: { type: CosmeticType.ContentDecoration } },
                { cosmetic: { UserCosmetic: { none: { userId: viewerId } } } },
              ],
            },
          ]
        : []),
      ...(viewerId && owned === 'owned'
        ? [{ cosmetic: { UserCosmetic: { some: { userId: viewerId } } } }]
        : []),
      // In `AND` rather than beside the branches above: a second top-level `OR`
      // key would replace the creator/pack one and widen the feed to every
      // official item.
      // Same fields as `shopItemMatchesSearch`, which searches the client-held grids
      // — except the description is matched as raw HTML here, not tag-stripped text.
      ...(query
        ? [
            {
              OR: [
                { title: { contains: query, mode: Prisma.QueryMode.insensitive } },
                { description: { contains: query, mode: Prisma.QueryMode.insensitive } },
                { cosmetic: { name: { contains: query, mode: Prisma.QueryMode.insensitive } } },
                ...(slugTerm
                  ? [
                      {
                        cosmetic: {
                          type: CosmeticType.Sticker,
                          data: { path: ['slug'], string_contains: slugTerm },
                        },
                      },
                    ]
                  : []),
              ],
            },
          ]
        : []),
    ],
  };

  const [raw, count] = await Promise.all([
    dbRead.cosmeticShopItem.findMany({
      where,
      take,
      skip,
      orderBy: communityCosmeticsOrderBy(sort),
      // addedById lets the client attribute the purchase to the owner's shop.
      select: { ...creatorStorefrontItemSelect, addedById: true },
    }),
    dbRead.cosmeticShopItem.count({ where }),
  ]);
  const sold = await getSoldCounts(raw.map((i) => i.id));
  // Same meta sanitation as the storefront.
  const items = raw.map((item) => ({
    ...item,
    meta: shopItemDisplayMeta(item.meta as CosmeticShopItemMeta | null, sold.get(item.id) ?? 0),
  }));
  return getPagingData({ items, count }, limit, page);
};

// Early Access download prices for the shop's Models section, keyed by model
// version id (the model feed doesn't carry earlyAccessConfig).
export const getEarlyAccessModelPrices = async ({ modelVersionIds }: GetEarlyAccessPricesInput) => {
  const prices: Record<number, number> = {};
  if (!modelVersionIds.length) return prices;
  const paidAccess = await getPaidAccess('ModelVersion', modelVersionIds);
  const gatedIds = modelVersionIds.filter((id) => paidAccess[id]?.terms);
  if (!gatedIds.length) return prices;

  // A public listing: no viewer, so everyone is quoted the buyer price — which means a live sale
  // discounts it. Reading the gate rows directly would advertise the pre-sale number.
  const monetization = await getViewerMonetization({
    versions: gatedIds.map((id) => ({ id })),
    viewer: {},
  });

  for (const id of gatedIds) {
    const terms = monetization[id]?.paidAccess?.terms as ModelVersionTerms | undefined;
    const price = terms?.download?.price ?? 0;
    if (price > 0) prices[id] = price;
  }
  return prices;
};

// ---------------------------------------------------------------------------
// Cross-creator selling: resell another creator's sellable shop item
// ---------------------------------------------------------------------------

// Gallery of published shop items other creators have marked sellable, excluding
// the caller's own and ones they already resell.
export const getPublicShopItemsForResale = async ({
  userId,
  limit,
  cursor,
  cosmeticTypes,
  query,
  stickersEnabled,
}: GetPublicShopItemsInput & { userId: number; stickersEnabled?: boolean }) => {
  const alreadyResold = (
    await dbRead.userCosmeticShopItemResale.findMany({
      where: { userId },
      select: { shopItemId: true },
    })
  ).map((r) => r.shopItemId);
  // A block in either direction removes the pairing from the resale gallery.
  const blockedPairIds = await getBlockedPairIds(userId);
  const raw = await dbRead.cosmeticShopItem.findMany({
    where: {
      status: CosmeticShopItemStatus.Published,
      meta: { path: ['sellableByOthers'], equals: true },
      // Packs are not resellable by reference: the resale split is computed from
      // one cosmetic's creator, and a pack has several.
      cosmeticId: { not: null },
      addedById: {
        not: userId,
        ...(blockedPairIds.length ? { notIn: blockedPairIds } : {}),
      },
      // Only surface items from creators whose shop is public (enabled).
      addedBy: { settings: { path: ['creatorShop', 'enabled'], equals: true } },
      ...(query
        ? {
            OR: [
              { title: { contains: query, mode: 'insensitive' } },
              { addedBy: { username: { contains: query, mode: 'insensitive' } } },
            ],
          }
        : {}),
      ...(cosmeticTypes?.length || !stickersEnabled
        ? {
            cosmetic: {
              type: {
                ...(cosmeticTypes?.length ? { in: cosmeticTypes } : {}),
                ...(stickersEnabled ? {} : { not: CosmeticType.Sticker }),
              },
            },
          }
        : {}),
    },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor } } : {}),
    orderBy: { id: 'desc' },
    select: {
      id: true,
      unitAmount: true,
      availableQuantity: true,
      meta: true,
      listed: true,
      cosmetic: { select: { id: true, name: true, type: true, data: true } },
      addedBy: { select: { id: true, username: true, image: true } },
    },
  });
  let nextCursor: number | undefined;
  if (raw.length > limit) nextCursor = raw.pop()?.id;
  const items = raw.map(({ meta, ...i }) => ({
    ...i,
    sellerShare: (meta as CosmeticShopItemMeta | null)?.sellerShare ?? 0,
    // Already in this creator's shop — the picker shows it as added/removable.
    isResold: alreadyResold.includes(i.id),
    // Delisted items stay in the picker, badged but unaddable — hiding them
    // would just make the reseller hunt for the item again once it's back.
    listed: i.listed,
  }));
  return { items, nextCursor };
};

// Load + validate a sellable shop item the caller may resell.
const getResellableItemOrThrow = async (shopItemId: number, userId: number) => {
  const item = await dbRead.cosmeticShopItem.findUnique({
    where: { id: shopItemId },
    select: { id: true, status: true, listed: true, addedById: true, meta: true },
  });
  if (!item) throw throwNotFoundError('Shop item not found');
  const meta = (item.meta ?? {}) as CosmeticShopItemMeta;
  if (!meta.sellableByOthers)
    throw throwAuthorizationError('This item is not available for other creators to sell');
  if (item.status !== CosmeticShopItemStatus.Published)
    throw throwBadRequestError('Only published items can be resold');
  // Existing listings outlive the creator pulling the item off sale, so a new
  // one must not be creatable while it's off — otherwise delisting is undone by
  // anyone who adds it, and a row could exist that was never a live agreement.
  if (!item.listed)
    throw throwBadRequestError('This item is not currently for sale — try again if it comes back');
  if (item.addedById === userId) throw throwBadRequestError('This is already your own item');
  // NotFound (not authorization) so the block itself isn't revealed, mirroring
  // the read-side block enforcement.
  if (item.addedById && (await getBlockedPairIds(userId)).includes(item.addedById))
    throw throwNotFoundError('Shop item not found');
  return item;
};

export const addResoldItem = async ({
  userId,
  shopItemId,
}: ResoldItemInput & { userId: number }) => {
  const item = await getResellableItemOrThrow(shopItemId, userId);
  const existing = await dbRead.userCosmeticShopItemResale.findUnique({
    where: { userId_shopItemId: { userId, shopItemId } },
    select: { shopItemId: true },
  });
  if (existing) throw throwBadRequestError('You are already reselling this item');
  // Append after the current last index rather than counting rows: removing a
  // listing doesn't reindex the rest, so a count can collide with an index that
  // is still in use ([0, 2] → 2).
  const { _max } = await dbRead.userCosmeticShopItemResale.aggregate({
    where: { userId },
    _max: { index: true },
  });
  // The row records the share on offer right now and is never rewritten: from
  // here on this reseller is paid what they signed up for, whatever the original
  // creator changes the item to later.
  return dbWrite.userCosmeticShopItemResale.create({
    data: {
      userId,
      shopItemId,
      sellerShare: (item.meta as CosmeticShopItemMeta | null)?.sellerShare ?? 0,
      index: (_max.index ?? -1) + 1,
    },
  });
};

export const removeResoldItem = async ({
  userId,
  shopItemId,
}: ResoldItemInput & { userId: number }) => {
  // Deleting the row drops the grandfathered share with it — relisting later is
  // a fresh agreement to whatever the item offers then.
  await dbWrite.userCosmeticShopItemResale.deleteMany({ where: { userId, shopItemId } });
};

// Storefront order for the resold section. Ids the caller doesn't resell are
// ignored rather than rejected — a stale client list shouldn't fail the drop.
export const reorderResoldItems = async ({
  userId,
  shopItemIds,
}: ReorderResoldItemsInput & { userId: number }) => {
  await dbWrite.$transaction(
    shopItemIds.map((shopItemId, index) =>
      dbWrite.userCosmeticShopItemResale.updateMany({
        where: { userId, shopItemId },
        data: { index },
      })
    )
  );
};

// The creator's own resell listings, in their saved order — powers the manage
// picker's reorder list. Unlike the storefront query this keeps items whose
// source shop is currently private so the owner can still see and remove them.
export const getResoldItemsForManage = async ({ userId }: { userId: number }) => {
  const rows = await dbRead.userCosmeticShopItemResale.findMany({
    where: { userId },
    orderBy: [{ index: 'asc' }, { shopItemId: 'asc' }],
    select: {
      sellerShare: true,
      shopItem: {
        select: {
          id: true,
          unitAmount: true,
          cosmetic: { select: { id: true, name: true, type: true, data: true } },
          addedBy: { select: { id: true, username: true, image: true } },
        },
      },
    },
  });
  return rows.map(({ shopItem, sellerShare }) => ({ ...shopItem, sellerShare }));
};

// Who resells one of your items, and on what terms — the question the settings
// blob couldn't answer without scanning every user. Ordered oldest-first, so the
// creators with the longest-standing grandfathered terms read first.
export const getShopItemResellers = async ({
  shopItemId,
  userId,
  isModerator,
}: GetShopItemResellersInput & { userId: number; isModerator?: boolean }) => {
  await getOwnedItemOrThrow(shopItemId, userId, isModerator);
  const rows = await dbRead.userCosmeticShopItemResale.findMany({
    where: { shopItemId },
    orderBy: { createdAt: 'asc' },
    select: {
      sellerShare: true,
      createdAt: true,
      // The list renders UserAvatar with decorations and username, which reads
      // the profile picture AND the equipped cosmetics. Selecting less than this
      // renders a bare placeholder for nearly every reseller.
      user: { select: userWithCosmeticsSelect },
    },
  });
  return rows
    .filter((r) => !r.user.deletedAt)
    .map(({ user: { deletedAt, ...user }, sellerShare, createdAt }) => ({
      user,
      sellerShare,
      listedAt: createdAt,
    }));
};

/**
 * Headline resale numbers for the manage view, both directions of the table in
 * one round trip. `resellers` is DISTINCT creators, not listings — one creator
 * reselling three of your items is one creator.
 */
export const getCreatorShopResaleStats = async ({ userId }: { userId: number }) => {
  const [stats] = await dbRead.$queryRaw<
    { resellers: number; resoldItems: number; reselling: number }[]
  >`
    SELECT
      COUNT(DISTINCT r."userId") FILTER (WHERE si."addedById" = ${userId})::int AS "resellers",
      COUNT(DISTINCT r."shopItemId") FILTER (WHERE si."addedById" = ${userId})::int AS "resoldItems",
      COUNT(*) FILTER (WHERE r."userId" = ${userId})::int AS "reselling"
    FROM "UserCosmeticShopItemResale" r
    JOIN "CosmeticShopItem" si ON si.id = r."shopItemId"
    WHERE si."addedById" = ${userId} OR r."userId" = ${userId}
  `;
  return stats ?? { resellers: 0, resoldItems: 0, reselling: 0 };
};

// ---------------------------------------------------------------------------
// Moderator: review queue
// ---------------------------------------------------------------------------

export const getCreatorShopReviewQueue = async ({
  limit,
  page,
  sort,
  status,
  username,
  userId,
  cosmeticTypes,
}: GetReviewQueueInput) => {
  // A pack has no cosmetic, so a `cosmetic` relation filter excludes it outright
  // — which is why packs never reached this queue at all. They are matched on
  // their lister instead.
  const types =
    cosmeticTypes?.filter(
      (t): t is CosmeticType => t !== PACK_FILTER_VALUE && t !== MYSTERY_PACK_FILTER_VALUE
    ) ?? [];
  const packsWanted = !cosmeticTypes?.length || cosmeticTypes.includes(PACK_FILTER_VALUE);
  const mysteryPacksWanted =
    !cosmeticTypes?.length || cosmeticTypes.includes(MYSTERY_PACK_FILTER_VALUE);
  const singlesWanted = !cosmeticTypes?.length || types.length > 0;

  // A specific status filters to it (including Archived); no status = every
  // status except Archived (the "All" option in the review queue).
  const statusWhere: Prisma.CosmeticShopItemWhereInput = status
    ? { status }
    : { status: { not: CosmeticShopItemStatus.Archived } };
  const where: Prisma.CosmeticShopItemWhereInput = {
    OR: [
      ...(mysteryPacksWanted
        ? [
            {
              itemDefinition: { sellerId: userId ?? { not: null } },
              ...(username
                ? { addedBy: { username: { contains: username, mode: 'insensitive' as const } } }
                : {}),
              // A pack on sale with an edit waiting is in review too.
              ...(status === CosmeticShopItemStatus.PendingReview
                ? {
                    OR: [
                      statusWhere,
                      {
                        status: CosmeticShopItemStatus.Published,
                        itemDefinition: { revisions: { some: { status: 'pending' } } },
                      },
                    ],
                  }
                : statusWhere),
            },
          ]
        : []),
      // Only creator-submitted items (exclude official/admin cosmetics).
      ...(singlesWanted
        ? [
            {
              ...statusWhere,
              cosmetic: {
                createdById: userId ?? { not: null },
                ...(types.length ? { type: { in: types } } : {}),
                ...(username
                  ? {
                      creator: { username: { contains: username, mode: 'insensitive' as const } },
                    }
                  : {}),
              },
            },
          ]
        : []),
      ...(packsWanted
        ? [
            {
              ...statusWhere,
              ...PACK_SHOP_ITEM_WHERE,
              addedById: userId ?? { not: null },
              ...(username
                ? { addedBy: { username: { contains: username, mode: 'insensitive' as const } } }
                : {}),
            },
          ]
        : []),
    ],
  };

  const { take, skip } = getPagination(limit, page);

  const [items, count] = await Promise.all([
    dbRead.cosmeticShopItem.findMany({
      where,
      take,
      skip,
      // `id` breaks ties so a page boundary can't drop or repeat an item when
      // two submissions share a createdAt.
      orderBy: [
        { createdAt: sort === 'newest' ? 'desc' : 'asc' },
        { id: sort === 'newest' ? 'desc' : 'asc' },
      ],
      select: {
        ...creatorShopItemSelect,
        // A pack has no cosmetic, so its author is the lister — without this the
        // review panel has nobody to attribute it to.
        addedBy: { select: { id: true, username: true, image: true } },
        itemDefinitionId: true,
        itemDefinition: {
          select: { revisions: { where: { status: 'pending' }, select: { id: true } } },
        },
        cosmetic: {
          select: {
            id: true,
            name: true,
            type: true,
            data: true,
            videoUrl: true,
            createdById: true,
            source: true,
            description: true,
            flags: true,
            creator: { select: { id: true, username: true, image: true } },
          },
        },
      },
    }),
    dbRead.cosmeticShopItem.count({ where }),
  ]);

  return getPagingData({ items, count }, take, page);
};

// Backs the review queue's creator filter: every user who has ever submitted a
// shop item, mirroring the queue's own creator predicate (a creator-owned
// cosmetic with at least one shop item). Deliberately not scoped to the active
// status/type filters so the selection survives flipping between them. The set
// is small enough to send whole — no cursor.
export const getCreatorShopReviewQueueCreators = async () => {
  const creators = await dbRead.user.findMany({
    where: {
      username: { not: null },
      createdCosmetics: { some: { cosmeticShopItems: { some: {} } } },
    },
    select: { id: true, username: true },
    orderBy: { username: 'asc' },
  });
  return creators.map(({ id, username }) => ({ id, username: username as string }));
};

export const reviewCreatorShopItem = async ({
  reviewerId,
  id,
  action,
  rejectionReason,
  boxRevisionId,
  reviewedVersion,
  stickersEnabled,
}: ReviewCreatorShopItemInput & { reviewerId: number; stickersEnabled: boolean }) => {
  const item = await dbWrite.cosmeticShopItem.findUnique({
    where: { id },
    select: {
      id: true,
      cosmeticId: true,
      status: true,
      title: true,
      addedById: true,
      itemDefinition: { select: { id: true, sellerId: true } },
      cosmetic: {
        // type + data feed creatorGrantRemaining below.
        select: {
          createdById: true,
          type: true,
          data: true,
          creator: { select: { username: true } },
        },
      },
    },
  });
  if (!item) throw throwNotFoundError('Shop item not found');
  if (item.status === CosmeticShopItemStatus.Archived)
    throw throwBadRequestError('Archived items cannot be reviewed');
  if (item.itemDefinition?.sellerId != null) {
    await reviewMysteryPack({
      boxId: item.itemDefinition.id,
      reviewerId,
      action,
      rejectionReason,
      stickersEnabled,
      revisionId: boxRevisionId,
    });
    return dbWrite.cosmeticShopItem.findUniqueOrThrow({
      where: { id },
      select: creatorShopItemSelect,
    });
  }
  if (reviewedVersion === undefined)
    await logToAxiom({
      level: 'warn',
      name: 'creator-shop-verdict-unpinned',
      message: 'Shop verdict sent without the version it reviewed',
      data: { shopItemId: id, reviewerId, action },
    }).catch(() => undefined);

  const now = new Date();
  const reviewFields = { reviewedById: reviewerId, reviewedAt: now };
  const nextStatus =
    action === 'approve'
      ? CosmeticShopItemStatus.Published
      : action === 'reject'
      ? CosmeticShopItemStatus.Rejected
      : action === 'revert'
      ? CosmeticShopItemStatus.PendingReview
      : CosmeticShopItemStatus.RequestedChanges;
  // The verdict is recorded on the history too, not just on rejectionReason —
  // the next edit clears that column, and a re-review needs to see what was
  // said last time.
  // A rejection refunds the item's buyers and reverses the creator's payouts. Any other verdict
  // stops a refund an earlier rejection left unfinished.
  const withdrawnRefund: CosmeticShopItemMeta['withdrawnRefund'] =
    action === 'reject' && item.cosmeticId != null
      ? { trigger: 'reject', clawback: true, userId: reviewerId, at: now.toISOString() }
      : undefined;
  const reviewedMeta = (meta: CosmeticShopItemMeta, extra: Partial<CosmeticShopItemMeta>) =>
    appendItemHistory(
      { ...meta, ...extra, withdrawnRefund },
      {
        at: now.toISOString(),
        userId: reviewerId,
        kind: 'reviewed',
        status: nextStatus,
        action,
        note: rejectionReason ?? undefined,
      }
    ) as Prisma.InputJsonValue;

  // The unequip sweep reads the verdict from the database, so it must run after this commits.
  const updated = await dbWrite.$transaction(async (tx) => {
    const current = await lockShopItem(tx, id);
    if (current.status === CosmeticShopItemStatus.Archived)
      throw throwBadRequestError('Archived items cannot be reviewed');
    // Rejected is deliberately NOT blocked here: this procedure is
    // moderatorProcedure, so a second verdict is the one way back from a mistaken
    // rejection, and it stays out of the creator's hands. Every path a creator can
    // reach — edit, list, archive, restore — refuses a rejected item.
    if (action === 'revert' && current.status !== CosmeticShopItemStatus.Published)
      throw throwBadRequestError('Only published items can be reverted to pending review');
    const meta = (current.meta ?? {}) as CosmeticShopItemMeta;
    // The verdict covers what the moderator saw, not whatever the creator uploaded since.
    if (reviewedVersion !== undefined && reviewedVersion !== shopItemReviewVersion(meta))
      throw throwConflictError(
        'This item changed since you opened it. Reload to review the current version.'
      );
    const written =
      action === 'approve'
        ? // Publish + record the approved price. Payout is wired at purchase time
          // from cosmetic.createdById — no paidToUserIds needed.
          await tx.cosmeticShopItem.update({
            where: { id },
            data: {
              ...reviewFields,
              status: nextStatus,
              rejectionReason: null,
              meta: reviewedMeta(meta, {
                lastApprovedAmount: current.unitAmount,
                displayApproved: true,
              }),
            },
            select: creatorShopItemSelect,
          })
        : // reject = terminal; request-changes = creator can edit & resubmit;
          // revert = unpublish back into the review queue. The note is kept on
          // rejectionReason so both the queue and the creator see why.
          await tx.cosmeticShopItem.update({
            where: { id },
            data: {
              ...reviewFields,
              status: nextStatus,
              rejectionReason: rejectionReason ?? null,
              meta: reviewedMeta(meta, { displayApproved: false }),
            },
            select: creatorShopItemSelect,
          });
    await recordShopVerdict(tx, id, {
      action,
      moderatorId: reviewerId,
      at: now.toISOString(),
      note: rejectionReason,
      statusBefore: current.status,
      statusAfter: nextStatus,
    });
    return written;
  }, SHOP_VERDICT_TRANSACTION);

  // On approval, grant the creator their own cosmetic (idempotent). A pack has
  // none of its own, and its members were granted when they were approved.
  if (action === 'approve' && item.cosmeticId != null && item.cosmetic?.createdById) {
    await dbWrite.userCosmetic.createMany({
      data: [
        {
          userId: item.cosmetic.createdById,
          cosmeticId: item.cosmeticId,
          claimKey: 'creator-shop',
          remaining: creatorGrantRemaining(item.cosmetic.type, item.cosmetic.data),
        },
      ],
      skipDuplicates: true,
    });
    await refreshOwnedStickerCache([item.cosmetic.createdById]);
  }

  // D14: an item leaving Published is no longer bundlable, so packs holding it
  // have to come off sale too.
  if (action !== 'approve' && item.cosmeticId != null) await delistPacksContaining(item.cosmeticId);
  if (action !== 'approve') await unequipWithheldCosmetic(item.cosmeticId);
  if (withdrawnRefund) await startWithdrawnRefund(id);

  // An unpublished item can't stay featured — free up its slot.
  if (action === 'revert' && item.addedById) {
    const settings = await getCreatorShopSettings({ userId: item.addedById });
    const featuredItemIds = settings.featuredItemIds ?? [];
    if (featuredItemIds.includes(id))
      await updateCreatorShopSettings({
        userId: item.addedById,
        featuredItemIds: featuredItemIds.filter((fid) => fid !== id),
      });
  }

  // Let the creator know the review outcome (best-effort).
  // A pack is authored by its lister, not by any one member's creator.
  const creatorId = item.cosmetic?.createdById ?? item.addedById;
  if (creatorId) {
    const username = item.cosmetic?.creator?.username ?? undefined;
    const type =
      action === 'approve'
        ? 'creator-shop-item-approved'
        : action === 'request-changes'
        ? 'creator-shop-item-changes-requested'
        : action === 'revert'
        ? 'creator-shop-item-reverted'
        : 'creator-shop-item-rejected';
    await createNotification({
      type,
      userId: creatorId,
      category: NotificationCategory.System,
      // Approvals dedupe per item; review verdicts can recur, so stamp them.
      key: action === 'approve' ? `${type}:${id}` : `${type}:${id}:${now.getTime()}`,
      details: { title: item.title, username, reason: rejectionReason ?? undefined },
    });
  }

  return updated;
};

type TakedownFailure = {
  /**
   * `box`: a box still holds the cosmetic, or an opening that drew it was left unrefunded. `cdn`:
   * recording its artwork for the image CDN failed; a retry records it.
   */
  stage: 'refund' | 'clawback' | 'box' | 'cdn';
  /** 0 for a box that could not be pulled, or a payout whose key names no recipient. */
  userId: number;
  amount?: number;
  boxId?: number;
  error: string;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? 'Unknown error');

// A takedown can run for minutes across hundreds of Buzz calls, so every money
// move gets a few attempts before it's written off as a failure a human has to
// finish. Transient 5xx/timeouts from the Buzz service are the common case.
const TAKEDOWN_MONEY_RETRIES = 3;
const TAKEDOWN_RETRY_DELAY_MS = 1000;

const takedownMoneyMove = <T>(fn: () => Promise<T>) =>
  withRetries(fn, TAKEDOWN_MONEY_RETRIES, TAKEDOWN_RETRY_DELAY_MS);

type PrefixRefund = Awaited<ReturnType<typeof refundMultiAccountTransaction>>;

/**
 * A purchase's refund, finished when an earlier attempt reversed part of it: a lost response, or a
 * run that died before recording it, makes the prefix refund answer 409 and reverse nothing, so
 * every retry would read a refunded buyer as owed. Reports every leg now reversed, as the plain
 * refund does, for the payout reversal that follows. Throws rather than report none: a purchase row
 * exists only once its charge did.
 */
async function refundPurchasePrefix(input: {
  externalTransactionIdPrefix: string;
  description: string;
}) {
  try {
    const refund = await refundMultiAccountTransaction(input);
    if (!refund.refundedTransactions.length)
      throw new Error(`Buzz lists no charge under ${input.externalTransactionIdPrefix}`);
    return refund;
  } catch (error) {
    if (getBuzzApiStatus(error) !== 409) throw error;
  }
  await refundAllLegsByPrefix(input);
  // Read back rather than trusting its counts: a 404 there returns zeros, and a single leg's 409 is
  // counted done without a refund on the ledger. Flagged refunded, a leg left charged is lost.
  const { reversed, missing } = await getPrefixRefundState(input.externalTransactionIdPrefix);
  if (!reversed.length || missing.length)
    throw new Error(
      `Refund of ${input.externalTransactionIdPrefix} left ${missing.length} of ${
        reversed.length + missing.length
      } transactions unreversed`
    );
  return {
    refundedTransactions: reversed.map((leg) => ({
      originalTransactionId: leg.transactionId,
      refundTransactionId: `refund-${leg.transactionId}`,
      accountType: leg.accountType,
      amount: leg.amount,
      originalExternalTransactionId: leg.externalTransactionId,
    })),
    totalRefunded: reversed.reduce((sum, leg) => sum + leg.amount, 0),
    externalTransactionIdPrefix: input.externalTransactionIdPrefix,
  } satisfies PrefixRefund;
}

const logTakedown = (level: 'info' | 'error', message: string, data: MixedObject) =>
  logToAxiom({ level, name: 'cosmetic-takedown', message, data }).catch(() => undefined);

/**
 * Pull a cosmetic that can't stay on sale (IP infringement / TOS) in one
 * operation: stop sales, refund every buyer, take back the Buzz the seller was
 * paid for those sales, and strip the cosmetic from everyone who owns or has it
 * equipped.
 *
 * The creator's submission fee is deliberately NOT refunded — a takedown is a
 * terms violation, and the fee paid for the review that caught it.
 *
 * Money moves are best-effort per buyer: one failed refund doesn't abort the
 * rest, it lands in `failures` for a moderator to finish by hand.
 */
export const takedownCosmeticShopItem = async ({
  id,
  reason,
  moderatorId,
}: TakedownCosmeticShopItemInput & { moderatorId: number }) => {
  const item = await dbRead.cosmeticShopItem.findUnique({
    where: { id },
    select: {
      id: true,
      cosmeticId: true,
      title: true,
      status: true,
      addedById: true,
      itemDefinitionId: true,
      cosmetic: { select: { createdById: true, creator: { select: { username: true } } } },
    },
  });
  if (!item) throw throwNotFoundError('Shop item not found');
  // Everything below reads a NULL cosmetic as a pack: refunds with no payouts to reverse and no
  // members to revoke. A box's held boxes and opened rewards are neither.
  if (item.itemDefinitionId != null)
    throw throwBadRequestError('Mystery box listings cannot be taken down here');

  const now = new Date();

  let retried = false;
  let note = reason;
  let artwork: ShopTakedownArtwork | undefined;
  // Stop sales first so nothing can be bought while the refunds run.
  const archive = async () => {
    // Under the row lock, not from the read above: the refund this waited on, or an edit, appends
    // its own history entry, and writing back an earlier copy would erase it.
    const updated = await dbWrite.$transaction(async (tx) => {
      const currentMeta = ((await lockShopItem(tx, id)).meta ?? {}) as CosmeticShopItemMeta;
      // A retry finishes the first takedown: its record and archive date stand.
      retried = !!currentMeta.takedown;
      note = retried ? `Retried: ${reason}` : reason;
      return tx.cosmeticShopItem.update({
        where: { id },
        data: {
          status: CosmeticShopItemStatus.Archived,
          listed: false,
          ...(retried ? {} : { archivedAt: now }),
          // Event tags place the item in tagged sections, as the rows deleted below do by hand.
          eventTags: [],
          meta: appendItemHistory(
            {
              ...currentMeta,
              takedown: currentMeta.takedown ?? { reason, moderatorId, at: now.toISOString() },
            },
            {
              at: now.toISOString(),
              userId: moderatorId,
              kind: 'takedown',
              status: CosmeticShopItemStatus.Archived,
              note,
            }
          ) as Prisma.InputJsonValue,
        },
        select: creatorShopItemSelect,
      });
    });
    // The image CDN stops serving the artwork; the stored original stays, as the label's evidence.
    // A retry records it again.
    try {
      artwork = await recordShopTakedownArtwork(id);
    } catch (error) {
      failures.push({ stage: 'cdn', userId: 0, error: errorMessage(error) });
    }
    // Official-shop placements are curated rows, not a status filter — drop them
    // or the item keeps rendering in its section.
    await dbWrite.cosmeticShopSectionItem.deleteMany({ where: { shopItemId: id } });
    await endResaleListings({ shopItemId: id, title: item.title });

    if (item.addedById) {
      const settings = await getCreatorShopSettings({ userId: item.addedById });
      const featuredItemIds = settings.featuredItemIds ?? [];
      if (featuredItemIds.includes(id))
        await updateCreatorShopSettings({
          userId: item.addedById,
          featuredItemIds: featuredItemIds.filter((fid) => fid !== id),
        });
    }
    return updated;
  };
  let updated: Awaited<ReturnType<typeof archive>> | undefined;

  let purchases: {
    userId: number;
    buzzTransactionId: string;
    unitAmount: number;
    meta: Prisma.JsonValue;
  }[] = [];

  const failures: TakedownFailure[] = [];
  // Payouts we can undo by refunding the exact transaction that paid them.
  const refundablePayouts: { userId: number; amount: number; transactionId: string }[] = [];
  // Everything else has to be reversed by charging the recipient, keyed per
  // recipient AND color: payouts were made in the colors the buyer paid with, so
  // they have to come back the same way.
  const clawback = new Map<string, number>();
  const addClawback = (userId: number, color: BuzzSpendType, amount: number) => {
    if (amount <= 0) return;
    const key = `${userId}:${color}`;
    clawback.set(key, (clawback.get(key) ?? 0) + amount);
  };

  const isPack = item.cosmeticId == null;
  // A pack's author is its lister; it has no cosmetic creator of its own.
  const creatorId = item.cosmetic?.createdById ?? item.addedById;
  // Payouts of the shelf purchases, reversed with each purchase from its ledger.
  let owedFromLedger = 0;
  let clawedBackFromLedger = 0;
  let refundedValue = 0;
  let reversedWithPurchase = 0;
  const leftToWithdrawnRefund: string[] = [];
  const refundedUserIds: number[] = [];

  let boxesPulled: Awaited<ReturnType<typeof pullCosmeticFromBoxes>> = { pulled: [], failed: [] };

  const archiveAndRefundBuyers = async () => {
    updated = await archive();
    // Boxes stop drawing it too, before anything is refunded: openers are found after this, so none
    // can draw it in between and keep it unrefunded.
    // Never thrown: the buyers below are still owed their refunds.
    if (item.cosmeticId != null)
      boxesPulled = await pullCosmeticFromBoxes({
        cosmeticId: item.cosmeticId,
        userId: moderatorId,
      }).catch((error) => ({ pulled: [], failed: [{ boxId: 0, error: errorMessage(error) }] }));
    // Primary, not the replica: a sale made seconds ago may not have replicated
    // yet, and missing it would strip that buyer's cosmetic without refunding it.
    purchases = await dbWrite.userCosmeticShopPurchases.findMany({
      where: { shopItemId: id, refunded: false },
      select: { userId: true, buzzTransactionId: true, unitAmount: true, meta: true },
    });
    await logTakedown('info', 'Takedown started', {
      shopItemId: id,
      moderatorId,
      reason,
      purchases: purchases.length,
    });
    await refundTakedownPurchases();
    return true;
  };
  // Held from the archive through the buyer refunds. A moderator's or a withdrawn-item refund
  // stamps purchases under this lock, and one stamping between the purchase read and these refunds
  // would refund the same purchase alongside the takedown.
  const locked = await withShopItemRefundLock(id, archiveAndRefundBuyers, { queue: true });
  // Not had in time, or Redis is down. A takedown pulls content and must not wait on either, so it
  // runs without the lock, logged: a refund running now may refund a purchase alongside it.
  if (locked === null) {
    await logTakedown('error', 'Takedown ran without the refund lock', { shopItemId: id });
    await archiveAndRefundBuyers();
  }
  if (!updated) throw throwNotFoundError('Shop item not found');

  /** `reversed`: transaction ids the purchase's own refund already reversed. */
  function reverseRecordedPayouts(
    recordedPayouts: NonNullable<CosmeticPurchaseMeta['payouts']>,
    reversed: Set<string>
  ) {
    // Payouts are keyed under the purchase prefix, so the refund may have reversed them.
    for (const payout of recordedPayouts) {
      if (payout.amount <= 0) continue;
      if (payout.transactionId && reversed.has(payout.transactionId))
        reversedWithPurchase += payout.amount;
      else if (payout.transactionId)
        refundablePayouts.push({
          userId: payout.userId,
          amount: payout.amount,
          transactionId: payout.transactionId,
        });
      else addClawback(payout.userId, payout.color as BuzzSpendType, payout.amount);
    }
  }

  async function refundTakedownPurchases() {
    // Checked above; a hoisted declaration does not keep that narrowing.
    if (!item) return;
    for (const purchase of purchases) {
      // A withdrawn-item refund has begun on this one under its own terms. That run finishes it,
      // as a takedown would now that the item is taken down (`refundWithdrawnShopItem`).
      if ((purchase.meta as CosmeticPurchaseMeta | null)?.withdrawnRefund) {
        leftToWithdrawnRefund.push(purchase.buzzTransactionId);
        continue;
      }
      const price = purchase.unitAmount;
      // Unreachable for anything the current code writes — a purchase computing to
      // zero is refused rather than completed. Kept because the failure mode if a
      // zero-price row ever appears by another route (a backfill, a data fix) is
      // that the refund is asked to reverse a transaction the Buzz service never
      // saw, which fails on every re-run while the cosmetics are already revoked.
      // Logged rather than silently swallowed: this branch marks a purchase
      // refunded without refunding it, which should never be routine.
      if (price === 0) {
        void logToAxiom({
          level: 'warn',
          message: 'Takedown skipped the refund for a zero-price purchase',
          data: {
            shopItemId: id,
            userId: purchase.userId,
            transactionId: purchase.buzzTransactionId,
          },
        }).catch(() => undefined);
        await dbWrite.userCosmeticShopPurchases.update({
          where: { buzzTransactionId: purchase.buzzTransactionId },
          data: { refunded: true },
        });
        refundedUserIds.push(purchase.userId);
        continue;
      }
      // The ledger, not `meta.payouts`, says what was paid: that write can fail after the payouts
      // land, and older sales stored the buyer charge's own id, under which the prefix lists only
      // the payout. The buyer is refunded first; then every payout.
      const outcome = await reversePurchase(purchase, {
        clawback: true,
        trigger: 'reject',
        description: `Cosmetic removed - ${item.title}`,
      });
      if (outcome.status === 'failed') {
        failures.push({
          stage: 'refund',
          userId: purchase.userId,
          amount: price - (outcome.refunded ?? 0),
          error: outcome.error,
        });
        // The buyer loses the cosmetic below regardless, so an unrefunded sale is
        // money owed to a real person — loud, and with the ids needed to finish it.
        await logTakedown('error', 'Buyer refund failed', {
          shopItemId: id,
          userId: purchase.userId,
          buzzTransactionId: purchase.buzzTransactionId,
          amount: price - (outcome.refunded ?? 0),
          error: outcome.error,
        });
        continue;
      }

      await dbWrite.userCosmeticShopPurchases.update({
        where: { buzzTransactionId: purchase.buzzTransactionId },
        data: { refunded: true },
      });
      refundedUserIds.push(purchase.userId);
      refundedValue += price;
      clawedBackFromLedger += outcome.clawedBack;
      owedFromLedger += outcome.clawedBack;

      // The buyer is whole; what is left is the payout, filed as that leg for a person to finish.
      // A legacy payout keyed by the purchase id alone went to the creator, a reseller or a listed
      // payee, and the ledger does not say which: user 0 rather than a guess someone gets billed on.
      for (const failure of outcome.payoutFailures) {
        owedFromLedger += failure.amount;
        failures.push({
          stage: 'clawback',
          userId: failure.recipientId ?? 0,
          amount: failure.amount,
          error: `Payout ${failure.transactionId} not reversed${
            failure.recipientId === undefined ? ' (recipient not on its key)' : ''
          }: ${failure.error}`,
        });
        await logTakedown('error', 'Payout refund failed', {
          shopItemId: id,
          userId: failure.recipientId ?? 0,
          buzzTransactionId: purchase.buzzTransactionId,
          payoutTransactionId: failure.transactionId,
          amount: failure.amount,
          error: failure.error,
        });
      }
    }
  }

  for (const { boxId, error } of boxesPulled.failed) {
    // Box 0: the boxes holding it could not be read, so any may still hold it.
    failures.push({ stage: 'box', userId: 0, boxId, error: `Box still holds it: ${error}` });
    await logTakedown('error', 'Box pull failed', { shopItemId: id, boxId, error });
  }

  // Openers lose what they drew with everyone else below, so each is paid back the box's price
  // (Justin, 2026-10-21). A box no one paid for is marked refunded and returns nothing.
  const boxRefundedUserIds: number[] = [];
  let boxRefundedValue = 0;
  if (item.cosmeticId != null) {
    const cosmeticId = item.cosmeticId;
    const boxClaims = await claimBoxRefundsForCosmetic({ cosmeticId, shopItemId: id }).catch(
      (error) => ({
        openings: 0,
        failed: [{ userId: 0, boxItemId: 'any', error: errorMessage(error) }],
      })
    );
    for (const { userId, boxItemId, error } of boxClaims.failed) {
      failures.push({
        stage: 'box',
        userId,
        error: `Opening ${boxItemId} left unrefunded: ${error}`,
      });
      await logTakedown('error', 'Box opening refund claim failed', {
        shopItemId: id,
        userId,
        boxItemId,
        error,
      });
    }

    // Every purchase claimed, by this run or an earlier one, carries `meta.takedownRefund` until it
    // is paid, so a run that dies past here is finished by running the takedown again.
    let owed: OwedBoxRefund[] = [];
    try {
      owed = await listOwedBoxRefunds({ cosmeticId, shopItemId: id });
    } catch (error) {
      failures.push({
        stage: 'box',
        userId: 0,
        error: `Box refunds not read: ${errorMessage(error)}`,
      });
      await logTakedown('error', 'Box refunds not read', {
        shopItemId: id,
        error: errorMessage(error),
      });
    }
    for (const purchase of owed) {
      let refund: PrefixRefund | undefined;
      try {
        if (purchase.unitAmount > 0)
          refund = await takedownMoneyMove(() =>
            refundPurchasePrefix({
              externalTransactionIdPrefix: purchase.buzzTransactionId,
              description: `Cosmetic removed - ${item.title}`,
            })
          );
      } catch (error) {
        // Still owed: "Retry takedown" pays it. Paying it by hand instead must also set
        // meta.takedownRefund.paidAt on the purchase, or a later retry pays it again.
        failures.push({
          stage: 'refund',
          userId: purchase.userId,
          amount: purchase.unitAmount,
          boxId: purchase.boxDefinitionId,
          error: errorMessage(error),
        });
        await logTakedown('error', 'Box buyer refund failed', {
          shopItemId: id,
          userId: purchase.userId,
          buzzTransactionId: purchase.buzzTransactionId,
          amount: purchase.unitAmount,
          error: errorMessage(error),
        });
        continue;
      }
      // The Buzz is back; a failed mark only means a re-run asks the prefix again and finds it done.
      await markBoxRefundPaid(purchase.buzzTransactionId).catch((error) =>
        logTakedown('error', 'Box refund paid but not marked', {
          shopItemId: id,
          buzzTransactionId: purchase.buzzTransactionId,
          error: errorMessage(error),
        })
      );
      if (!refund) continue;
      boxRefundedUserIds.push(purchase.userId);
      boxRefundedValue += purchase.unitAmount;

      const recordedPayouts = (purchase.meta as CosmeticPurchaseMeta | null)?.payouts;
      if (recordedPayouts?.length)
        reverseRecordedPayouts(
          recordedPayouts,
          new Set(refund.refundedTransactions.map((t) => t.originalTransactionId))
        );
      // A platform box paid only the bank. A creator's box paid its creator, in a split only the
      // record knows, so like a pack it is left to a moderator.
      else if (!recordedPayouts && purchase.sellerId !== null)
        failures.push({
          stage: 'clawback',
          userId: purchase.sellerId,
          amount: purchase.unitAmount,
          boxId: purchase.boxDefinitionId,
          error: `Box purchase ${purchase.buzzTransactionId} has no recorded payouts; the creator's share cannot be re-derived`,
        });
    }
  }

  let clawedBack = clawedBackFromLedger + reversedWithPurchase;
  // Refunding the payout transaction is the cleanest reversal: the Buzz service
  // ties it to the original, so it can't double-apply and needs no external id of
  // our own.
  for (const payout of refundablePayouts) {
    try {
      await takedownMoneyMove(() =>
        refundTransaction(payout.transactionId, `Cosmetic removed - ${item.title}`)
      );
      clawedBack += payout.amount;
    } catch (error) {
      failures.push({
        stage: 'clawback',
        userId: payout.userId,
        amount: payout.amount,
        error: errorMessage(error),
      });
      await logTakedown('error', 'Payout refund failed', {
        shopItemId: id,
        userId: payout.userId,
        payoutTransactionId: payout.transactionId,
        amount: payout.amount,
        error: errorMessage(error),
      });
    }
  }

  for (const [key, amount] of clawback) {
    const [recipientId, color] = key.split(':') as [string, BuzzSpendType];
    // Retried on the same external id on purpose: if an attempt actually landed
    // before erroring, the duplicate is rejected rather than charged twice.
    const externalTransactionId = `cosmetic-takedown-${id}:clawback:${recipientId}:${color}:${now.getTime()}`;
    try {
      await takedownMoneyMove(() =>
        createBuzzTransaction({
          fromAccountId: Number(recipientId),
          fromAccountType: color,
          toAccountId: 0,
          amount,
          type: TransactionType.Refund,
          description: `Cosmetic removed - earnings reversed - ${item.title}`,
          // Stamped per run: the amount is an aggregate over the sales refunded in
          // THIS run, so a second takedown pass (sales that failed or landed late)
          // must not be swallowed as a duplicate of the first.
          externalTransactionId,
        })
      );
      clawedBack += amount;
    } catch (error) {
      failures.push({
        stage: 'clawback',
        userId: Number(recipientId),
        amount,
        error: errorMessage(error),
      });
      await logTakedown('error', 'Earnings clawback failed', {
        shopItemId: id,
        userId: Number(recipientId),
        color,
        amount,
        externalTransactionId,
        error: errorMessage(error),
      });
    }
  }

  // Everyone loses the cosmetic — buyers, the creator's own grant, and anyone it
  // was gifted to. Equipped placements are cleaned up by the revoke helper.
  //
  // A pack revokes only what it granted, keyed by the purchase transactions it
  // was bought through. Its members are sold individually too, and taking down
  // the bundle is not grounds for stripping a member someone bought on its own.
  // D14 again: a taken-down cosmetic can never be sold, in a pack or otherwise.
  if (item.cosmeticId != null) await delistPacksContaining(item.cosmeticId);

  const memberIds = isPack
    ? (
        await dbRead.cosmeticShopItemCosmetic.findMany({
          where: { shopItemId: id },
          select: { cosmeticId: true },
        })
      ).map((m) => m.cosmeticId)
    : [item.cosmeticId as number];
  // Empty is meaningful, and must not read as "unscoped": a pack that never
  // sold (or whose only sale was already refunded) grants nothing, so there is
  // nothing to revoke. Widening it here would strip every member cosmetic from
  // everyone who ever obtained one, by any route, with no refund.
  const packClaimKeys = isPack ? purchases.map((p) => p.buzzTransactionId) : undefined;
  const owners =
    memberIds.length && (!isPack || packClaimKeys?.length)
      ? await dbWrite.userCosmetic.findMany({
          where: {
            cosmeticId: { in: memberIds },
            ...(packClaimKeys ? { claimKey: { in: packClaimKeys } } : {}),
          },
          select: { userId: true },
        })
      : [];
  const ownerIds = [...new Set(owners.map((o) => o.userId))];
  const { revoked } =
    ownerIds.length && memberIds.length
      ? await revokeCosmeticsFromUsers({
          userIds: ownerIds,
          cosmeticIds: memberIds,
          claimKeys: packClaimKeys,
        })
      : { revoked: 0 };

  // Revoking the holding does not touch stickers already placed on other
  // people's images — those live in `Placement` with the cosmetic id inside a
  // JSON payload, and the overlay resolves artwork by cosmetic id with no join
  // to `UserCosmetic`, so a revoked sticker keeps rendering at full opacity on
  // everything it was placed on. Taking it down there is the whole point.
  //
  // Drained rather than run once: the helper is bounded per batch,
  // and one pass would report a clean takedown with the artwork still up.
  // Capped so a runaway cannot hold the request; `hasMore` says to run again.
  //
  // Not scoped to `ownerIds`, though the revoke above is. A pack's claim keys
  // exclude every holding obtained by another route, and the sharpest of those
  // is the maker's own creator grant — scoping the sweep the same way leaves the
  // abusive artwork up on everything its author placed it on. See the note on
  // `removePlacementsByCosmetic`; the trade is deliberate and was tried the
  // other way first.
  //
  // **Single items only, by decision.** Taking a pack down takes down the
  // bundle, not the artwork in it (Justin, 2026-08-09) — its members stay on
  // sale, which is why nothing delists them above. Sweeping here would remove
  // every placement of every member site-wide while those members remain
  // purchasable and immediately re-placeable, judging artwork nobody judged.
  // Abusive artwork is taken down per member, and that path does sweep.
  // Rows a batch could not settle, excluded once they have failed twice.
  // `ORDER BY id` is stable, so a permanently failing row is re-selected first
  // every time and would otherwise burn all ten iterations. Excluding on the
  // FIRST failure instead would give a transient Buzz or Redis blip zero
  // retries, and nothing re-runs a takedown afterwards — so each row gets one
  // more go before the sweep stops spending batches on it.
  const failureCount = new Map<number, number>();
  const unsettled: number[] = [];
  let placementsRemoved = {
    settled: 0,
    takenDown: 0,
    failed: 0,
    hasMore: false,
    // Reported, not just logged. A moderator taking a pack down over abusive
    // artwork will otherwise reasonably believe the artwork is gone from the
    // images it was placed on, and it is still there and still rendering.
    skippedForPack: false,
  };
  for (let batch = 0; batch < 10 && memberIds.length && !isPack; batch++) {
    let result: Awaited<ReturnType<typeof removePlacementsByCosmetic>>;
    try {
      result = await removePlacementsByCosmetic({
        cosmeticIds: memberIds,
        skipIds: unsettled,
        actorId: moderatorId,
      });
    } catch (error) {
      await logTakedown('error', 'Placement takedown failed', {
        shopItemId: id,
        cosmeticIds: memberIds,
        error: errorMessage(error),
      });
      break;
    }

    for (const placementId of result.failed) {
      const failures = (failureCount.get(placementId) ?? 0) + 1;
      failureCount.set(placementId, failures);
      if (failures > 1) unsettled.push(placementId);
    }
    placementsRemoved = {
      ...placementsRemoved,
      settled: placementsRemoved.settled + result.settled,
      takenDown: placementsRemoved.takenDown + result.takenDown,
      // Distinct rows, not attempts — a row is selected again on its retry, so
      // summing per-batch failures reports double what is actually stuck.
      failed: failureCount.size,
      hasMore: result.hasMore,
    };
    if (!result.hasMore) break;
  }

  if (isPack && memberIds.length) {
    placementsRemoved.skippedForPack = true;
    await logTakedown('info', 'Placement sweep skipped for a pack takedown', {
      shopItemId: id,
      cosmeticIds: memberIds,
    });
  }

  if (placementsRemoved.hasMore || placementsRemoved.failed)
    await logTakedown('error', 'Placement takedown left work behind', {
      shopItemId: id,
      ...placementsRemoved,
    });

  if (creatorId && !retried) {
    await createNotification({
      type: 'creator-shop-item-taken-down',
      userId: creatorId,
      category: NotificationCategory.System,
      key: `creator-shop-item-taken-down:${id}:${now.getTime()}`,
      details: { title: item.title, reason },
    });
  }
  for (const userId of new Set([...refundedUserIds, ...boxRefundedUserIds])) {
    await createNotification({
      type: 'cosmetic-shop-item-taken-down',
      userId,
      category: NotificationCategory.System,
      key: `cosmetic-shop-item-taken-down:${id}:${userId}`,
      details: { title: item.title },
    });
  }

  const owedBack =
    owedFromLedger +
    reversedWithPurchase +
    refundablePayouts.reduce((sum, p) => sum + p.amount, 0) +
    [...clawback.values()].reduce((sum, amount) => sum + amount, 0);

  // One record per run with the totals, so a partially-completed takedown can be
  // reconciled without replaying the individual failure logs.
  await logTakedown(failures.length ? 'error' : 'info', 'Takedown finished', {
    shopItemId: id,
    moderatorId,
    purchases: purchases.length,
    refunded: refundedUserIds.length,
    refundedValue,
    owedBack,
    clawedBack,
    revokedFrom: revoked,
    placementsRemoved,
    boxesPulled: boxesPulled.pulled,
    boxOpeningsRefunded: boxRefundedUserIds.length,
    boxRefundedValue,
    failures,
    leftToWithdrawnRefund,
    artwork,
  });

  await recordShopTakedownLabel(id, {
    moderatorId,
    at: now.toISOString(),
    note,
    statusBefore: item.status,
    statusAfter: CosmeticShopItemStatus.Archived,
  });

  return {
    item: updated,
    purchases: purchases.length,
    refunded: refundedUserIds.length,
    refundedValue,
    // What the sellers were paid for the refunded sales, and the share of those
    // sales it represents — `clawedBack` is what actually moved back, `owedBack`
    // what was due, so a failed transfer is visible as the gap between them.
    owedBack,
    clawedBack,
    clawedBackPct: refundedValue > 0 ? Math.round((owedBack / refundedValue) * 100) : 0,
    revokedFrom: revoked,
    placementsRemoved,
    boxesPulled: boxesPulled.pulled.length,
    // Openers paid back the price of the box that drew it; not counted in `refunded`.
    boxOpeningsRefunded: boxRefundedUserIds.length,
    boxRefundedValue,
    failures,
    /** Artwork keys this takedown did not record for the image CDN, left for a moderator. */
    artworkLeftServing: artwork ? artwork.unproven + artwork.otherOwner + artwork.inUse : 0,
  };
};

// ---------------------------------------------------------------------------
// Shop settings (stored on User.settings JSON — no dedicated table)
// ---------------------------------------------------------------------------

type CreatorShopSettings = NonNullable<UserSettingsSchema['creatorShop']>;

export const getCreatorShopSettings = async ({
  userId,
}: {
  userId: number;
}): Promise<CreatorShopSettings> => {
  const user = await dbRead.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const settings = (user?.settings ?? {}) as UserSettingsSchema;
  return settings.creatorShop ?? {};
};

export const updateCreatorShopSettings = async ({
  userId,
  servicesEnabled = false,
  ...patch
}: UpdateCreatorShopSettingsInput & { userId: number; servicesEnabled?: boolean }) => {
  // The merge happens in Postgres, over the stored column. Reading the blob into JS
  // and writing the whole object back replaced every other settings key with the value
  // it held at read time, discarding any write that landed in between (a notice
  // dismissal, a feature toggle, a content preference).
  const settings = await dbWrite.$transaction(async (tx) => {
    if (patch.enabled === true) {
      // Don't let a creator publish an empty shop — there'd be nothing to show.
      const itemCount =
        (await tx.cosmeticShopItem.count({ where: { addedById: userId } })) ||
        (servicesEnabled
          ? await tx.serviceOffering.count({
              where: {
                sellerId: userId,
                status: ServiceOfferingStatus.Active,
                seller: { muted: false },
              },
            })
          : 0);
      if (itemCount === 0)
        throw throwBadRequestError('Add at least one item to your shop before publishing.');
    }

    // Every field of the input is optional, so `patch` can be empty. `patchUserSettings`
    // then writes nothing and returns the row read inside this transaction — the same
    // value the old read-merge-write returned for an empty patch, and deliberately not
    // the Redis-cached blob, which can be hours old.
    return patchUserSettings(userId, { mergeInto: { creatorShop: patch } }, tx);
  });

  // After commit — the settings cache is Redis, and it was never busted here at all,
  // so `getUserSettings` served a pre-shop blob for up to its 4h TTL.
  await bustUserSettings(userId);
  // The creator card shows whether the shop is public (`creatorShopEnabled`).
  await bustUserCreator(userId);
  return (settings.creatorShop ?? {}) as CreatorShopSettings;
};
