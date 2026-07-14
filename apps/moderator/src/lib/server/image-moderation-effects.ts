import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { sql } from '@civitai/db/kysely';
import { NsfwLevel } from '@civitai/shared';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '@civitai/redis';
import { NotificationCategory } from '@civitai/notifications';
import { dbRead } from './db';
import { getBuzz } from './buzz';
import { bustCacheTag, bustCachedObject } from './cache';
import { getClickhouse } from './clickhouse';
import { getNotifications } from './notifications';
import { getSysRedis } from './redis';
import { syncSearchIndex } from './search-index';
import { appealResolutionEmail } from './emails/appeal-resolution.email';

// Side effects the main app's moderateImages runs alongside the Image row write. Ported so the spoke's
// accept/block are faithful. Meilisearch stays the callback (syncSearchIndex); ClickHouse + comic re-queue
// run here directly against the spoke's own clients.

// `blocked_images.reason`. The main app's getReviewTypeToBlockedReason switches on needsReview-style keys
// ('csam'/'newUser'/…) but its ONE caller feeds it `blockedFor ?? 'moderated'` — which never matches those
// keys — so the legacy always stores 'TOS' here (a latent bug). We deliberately key off needsReview
// (blockedFor is null on the review path) to store the intended CSAM/Ownership; do NOT "fix" this back to
// match the legacy always-TOS behavior.
function reviewTypeToBlockReason(reason: string | null | undefined): 'Ownership' | 'CSAM' | 'TOS' {
  switch (reason) {
    case 'csam':
      return 'CSAM';
    case 'newUser':
      return 'Ownership';
    default:
      return 'TOS';
  }
}

// Re-queue every comic project that contains any of these images for a Meilisearch refresh. Comic
// visibility is derived from Image.needsReview/ingestion/tosViolation, but the scan-workflow re-queue isn't
// on the moderator path — so mirror the main app's queueComicsForPanelImages. Covers the multi-comic case
// (an image reused across projects), unlike a single posted projectId.
export async function queueComicsForImages(imageIds: number[]): Promise<void> {
  if (!imageIds.length) return;
  const rows = await dbRead
    .selectFrom('ComicPanel')
    .select('projectId')
    .distinct()
    .where('imageId', 'in', imageIds)
    .execute();
  for (const { projectId } of rows)
    syncSearchIndex({ entityType: 'comic', entityId: projectId, action: 'update' });
}

// Mark images as non-existent in the shared feed existence cache (sysRedis) so embeds/references stop
// treating a just-blocked image as live before the 5-min TTL. Mirrors invalidateManyImageExistence; set
// per-key to avoid CROSSSLOT, and write the same `'false'` value the main app's reader expects.
export async function invalidateImagesExistence(imageIds: number[]): Promise<void> {
  if (!imageIds.length) return;
  const sys = getSysRedis();
  await Promise.all(
    imageIds.map((id) =>
      sys.packed.set(`${REDIS_SYS_KEYS.CACHES.IMAGE_EXISTS}:${id}`, 'false', { EX: 60 * 5 })
    )
  );
}

// Bust the model-gallery caches for every post touched by a moderation write, so a blocked/accepted image
// drops out of (or reappears in) those galleries immediately, not after the TTL — matters most for fast
// removal (DMCA/CSAM). Ports the main app's bustCachesForPosts. Two cache families:
//   - the getAllImages feed galleries, keyed by tag (`images-modelVersion:X` / `images-model:X` /
//     `images-model3d:X`) → bustCacheTag;
//   - the per-version showcase gallery (imagesForModelVersionsCache), one packed key per version → bust it
//     like any other cached object.
// The main app "refreshes" (re-populates from primary) the showcase cache rather than busting, purely to
// dodge a replication-lag re-cache window — but lag routing is off by default and it busts every OTHER
// gallery cache anyway, so a plain bust here is the consistent, faithful choice (reader re-fetches on the
// next miss). dbRead is fine: the Image write has committed and Post→version/model links don't change on
// moderation.
export async function bustPostGalleryCaches(postIds: number[]): Promise<void> {
  const ids = [...new Set(postIds.filter((id) => id != null))];
  if (!ids.length) return;
  const rows = await dbRead
    .selectFrom('Post as p')
    .leftJoin('ModelVersion as mv', 'mv.id', 'p.modelVersionId')
    .select([
      'p.modelVersionId as modelVersionId',
      'mv.modelId as modelId',
      'p.model3dId as model3dId',
    ])
    .where('p.id', 'in', ids)
    .execute();

  const modelVersionIds = [
    ...new Set(rows.map((r) => r.modelVersionId).filter((x): x is number => x != null)),
  ];
  const modelIds = [...new Set(rows.map((r) => r.modelId).filter((x): x is number => x != null))];
  const model3dIds = [
    ...new Set(rows.map((r) => r.model3dId).filter((x): x is number => x != null)),
  ];

  const tags = [
    ...modelVersionIds.map((id) => `images-modelVersion:${id}`),
    ...modelIds.map((id) => `images-model:${id}`),
    ...model3dIds.map((id) => `images-model3d:${id}`),
  ];
  await Promise.all([
    tags.length ? bustCacheTag(tags) : Promise.resolve(),
    bustCachedObject(REDIS_KEYS.CACHES.IMAGES_FOR_MODEL_VERSION, modelVersionIds),
  ]);
}

// pHash blocklist (ClickHouse `blocked_images`, `hash` = Int64). Add on block so re-uploads of the same
// image auto-block; soft-remove (disabled=true) on accept. Ports bulkAddBlockedImages /
// bulkRemoveBlockedImages, but keeps the FULL-precision pHash: it's a signed 64-bit value that overflows
// JS `number` (the main app's `Number(hash)` truncates the low digits), and the re-upload check matches on
// the full bigint. `pHash` is already a string in Kysely; ClickHouse parses a quoted Int64 exactly.
type BlockableImage = {
  pHash: string | null;
  needsReview: string | null;
  blockedFor: string | null;
};

export async function addImagesToBlocklist(images: BlockableImage[]): Promise<void> {
  const values = images
    .filter((i): i is BlockableImage & { pHash: string } => !!i.pHash)
    .map((i) => ({
      hash: i.pHash,
      reason: reviewTypeToBlockReason(i.blockedFor ?? i.needsReview),
    }));
  if (!values.length) return;
  await getClickhouse().insert({ table: 'blocked_images', values, format: 'JSONEachRow' });
}

export async function removeImagesFromBlocklist(pHashes: (string | null)[]): Promise<void> {
  const hashes = pHashes.filter((h): h is string => !!h);
  if (!hashes.length) return;
  const ch = getClickhouse();
  const resultSet = await ch.query({
    query: `SELECT hash, reason FROM "blocked_images" WHERE hash IN (${hashes.join(
      ','
    )}) AND disabled = false`,
    format: 'JSONEachRow',
  });
  const blocked = await resultSet.json<{ hash: string; reason: string }[]>();
  if (!blocked.length) return;
  await ch.insert({
    table: 'blocked_images',
    values: blocked.map((b) => ({ hash: b.hash, reason: b.reason, disabled: true })),
    format: 'JSONEachRow',
  });
}

// DeleteTOS analytics — one row per blocked image in the ClickHouse `images` table (feeds appeal
// `tosReason` + strike/leaderboard analytics). Ports the block-only branch of moderateImageHandler +
// Tracker.images. The two mapping tables mirror src/server/common/tos-reasons.ts; the nsfw enum mirrors
// getNsfwLevelDeprecatedReverseMapping. Purely additive analytics, so a ClickHouse failure is logged and
// swallowed rather than failing the block.
const NSFW_LEVEL_TO_DEPRECATED: Record<number, 'None' | 'Soft' | 'Mature' | 'X' | 'Blocked'> = {
  [NsfwLevel.PG]: 'None',
  [NsfwLevel.PG13]: 'Soft',
  [NsfwLevel.R]: 'Mature',
  [NsfwLevel.X]: 'X',
  [NsfwLevel.XXX]: 'X',
  [NsfwLevel.Blocked]: 'Blocked',
};

const NEEDS_REVIEW_TO_VIOLATION: Record<string, string> = {
  minor: 'realisticMinor',
  poi: 'realPerson',
  csam: 'realisticMinorNsfw',
  tag: 'other',
  newUser: 'other',
  blocked: 'other',
  appeal: 'other',
  bestiality: 'bestiality',
};

const REPORT_VIOLATION_TO_TYPE: Record<string, string> = {
  'Depiction of real-person likeness': 'realPerson',
  'Graphic violence': 'gore',
  'False impersonation': 'other',
  'Deceptive content': 'other',
  'Sale of illegal substances': 'other',
  'Child abuse and exploitation': 'realisticMinorNsfw',
  'Photorealistic depiction of a minor': 'realisticMinor',
  'Prohibited concepts': 'other',
};

function mapToViolationType(
  needsReview: string | null | undefined,
  reportViolation: string | null | undefined
): string {
  if (reportViolation && REPORT_VIOLATION_TO_TYPE[reportViolation])
    return REPORT_VIOLATION_TO_TYPE[reportViolation];
  if (needsReview && NEEDS_REVIEW_TO_VIOLATION[needsReview])
    return NEEDS_REVIEW_TO_VIOLATION[needsReview];
  return 'other';
}

export type ImageDeleteTosInput = {
  imageId: number;
  ownerId: number;
  // The image's nsfwLevel BEFORE the block write (mapped to the deprecated enum for the `nsfw` column).
  nsfwLevel: number;
  needsReview: string | null;
  actorUserId: number;
  ip?: string;
  userAgent?: string;
  violationType?: string;
  violationDetails?: string;
};

export async function trackImageDeleteTos(input: ImageDeleteTosInput): Promise<void> {
  const { imageId, ownerId, nsfwLevel, needsReview, actorUserId } = input;
  try {
    const [tagRows, resourceRows, reportRes] = await Promise.all([
      dbRead
        .selectFrom('TagsOnImageDetails as toi')
        .innerJoin('Tag as t', 't.id', 'toi.tagId')
        .select('t.name')
        .where('toi.imageId', '=', imageId)
        .where('toi.disabled', '=', false)
        .execute(),
      dbRead
        .selectFrom('ImageResourceNew')
        .select('modelVersionId')
        .where('imageId', '=', imageId)
        .execute(),
      // Latest TOS-violation report's structured detail (DISTINCT ON via LIMIT 1). jsonb `->>` on details.
      sql<{ violation: string | null; comment: string | null }>`
        SELECT r.details->>'violation' AS violation, r.details->>'comment' AS comment
        FROM "Report" r
        JOIN "ImageReport" ir ON ir."reportId" = r.id
        WHERE ir."imageId" = ${imageId} AND r.reason = 'TOSViolation'
        ORDER BY r."createdAt" DESC
        LIMIT 1
      `.execute(dbRead),
    ]);

    const report = reportRes.rows[0];
    await getClickhouse().insert({
      table: 'images',
      values: [
        {
          type: 'DeleteTOS',
          userId: actorUserId,
          imageId,
          tags: tagRows.map((r) => r.name),
          nsfw: NSFW_LEVEL_TO_DEPRECATED[nsfwLevel] ?? 'None',
          ip: input.ip ?? 'unknown',
          userAgent: input.userAgent ?? 'unknown',
          ownerId,
          tosReason: needsReview ?? 'other',
          violationType: input.violationType ?? mapToViolationType(needsReview, report?.violation),
          violationDetails: input.violationDetails ?? report?.comment ?? '',
          resources: resourceRows.map((r) => r.modelVersionId),
          via: 'web',
          viaClientId: '',
          viaApiKeyId: 0,
        },
      ],
      format: 'JSONEachRow',
    });
  } catch (e) {
    console.error('trackImageDeleteTos failed', { imageId, error: (e as Error).message });
  }
}

// tos-violation notification to the image owner. Ports the `user-notification` branch of
// handleBlockImages (the handler hardcodes that include). Delivery is best-effort — the notifications
// client logs its own failures via onFailure and we swallow here so a blocked image is never held up by
// notification delivery (matching the monolith's `.catch()`).
export async function notifyImageTosViolation(image: {
  imageId: number;
  ownerId: number;
  postId: number | null;
}): Promise<void> {
  try {
    await getNotifications().createNotification({
      userId: image.ownerId,
      type: 'tos-violation',
      category: NotificationCategory.System,
      key: `tos-violation:image:${randomUUID()}`,
      details: {
        modelName: image.postId ? `post #${image.postId}` : 'a post',
        entity: 'image',
        url: `/images/${image.imageId}`,
      },
    });
  } catch {
    // onFailure already logged; best-effort.
  }
}

// The side effects every verdict shares: an image's visibility flipped, so drop/re-add it in the model
// galleries and re-index its parent comic(s). Composed by the accept/block bundles; it's also the whole
// bundle for an appeal resolution.
export async function applyVisibilitySideEffects(
  imageId: number,
  postId: number | null
): Promise<void> {
  await Promise.all([
    bustPostGalleryCaches(postId != null ? [postId] : []),
    queueComicsForImages([imageId]),
  ]);
}

// The post-write side effects of a block, run together. These are all independent of one another, so —
// like the legacy handleBlockImages' `Promise.all` — they fan out concurrently. `img` is the PRE-block
// row (pHash/nsfwLevel/needsReview/postId/owner captured before the update). DeleteTOS + the notification
// swallow their own failures; the rest reject, so a genuine infra failure surfaces to the moderator.
export type BlockedImageRow = {
  pHash: string | null;
  needsReview: string | null;
  blockedFor: string | null;
  nsfwLevel: number;
  postId: number | null;
  userId: number;
};

export async function applyBlockSideEffects(
  img: BlockedImageRow,
  actor: { imageId: number; actorUserId: number; ip?: string; userAgent?: string }
): Promise<void> {
  const { imageId, actorUserId, ip, userAgent } = actor;
  await Promise.all([
    addImagesToBlocklist([
      { pHash: img.pHash, needsReview: img.needsReview, blockedFor: img.blockedFor },
    ]),
    trackImageDeleteTos({
      imageId,
      ownerId: img.userId,
      nsfwLevel: img.nsfwLevel,
      needsReview: img.needsReview,
      actorUserId,
      ip,
      userAgent,
    }),
    notifyImageTosViolation({ imageId, ownerId: img.userId, postId: img.postId }),
    invalidateImagesExistence([imageId]),
    applyVisibilitySideEffects(imageId, img.postId),
  ]);
}

// The post-write side effects of an accept: re-admit the pHash (re-uploads stop auto-blocking) and
// propagate the now-visible image to galleries + comics. Independent → concurrent.
export async function applyAcceptSideEffects(
  img: { pHash: string | null; postId: number | null },
  imageId: number
): Promise<void> {
  await Promise.all([
    removeImagesFromBlocklist([img.pHash]),
    applyVisibilitySideEffects(imageId, img.postId),
  ]);
}

// --- Appeal-resolution effects (resolveImageAppeal) — ports resolveEntityAppeal's per-user cascade ------

const isAppealPrefix = (prefix: string) => prefix.startsWith('appeal-');

// Refund the appeal fee via the buzz service. Best-effort — an old transaction may no longer exist in the
// buzz service, and a refund failure must never block the appeal resolution (mirrors the legacy
// withRetries + catch). A multi-account appeal charge uses a `appeal-`-prefixed external id.
export async function refundAppealFee(appeal: {
  id: number;
  buzzTransactionId: string | null;
  entityId: number;
}): Promise<void> {
  if (!appeal.buzzTransactionId) return;
  const description = `Refunded appeal ${appeal.id} for Image ${appeal.entityId}`;
  try {
    if (isAppealPrefix(appeal.buzzTransactionId))
      await getBuzz().refundMultiTransaction({
        externalTransactionIdPrefix: appeal.buzzTransactionId,
        description,
      });
    else await getBuzz().refundTransaction(appeal.buzzTransactionId, { description });
  } catch (e) {
    console.error('refundAppealFee failed', { appealId: appeal.id, error: (e as Error).message });
  }
}

// entity-appeal-resolved notification to the appellant (best-effort). The moderator's free-text
// `resolvedMessage` IS surfaced in-app here (unlike the email).
export async function notifyAppealResolved(input: {
  userId: number;
  entityId: number;
  status: 'Approved' | 'Rejected';
  resolvedMessage?: string;
}): Promise<void> {
  try {
    await getNotifications().createNotification({
      userId: input.userId,
      type: 'entity-appeal-resolved',
      category: NotificationCategory.Other,
      key: `entity-appeal-resolved:Image:${input.entityId}`,
      details: {
        entityType: 'Image',
        entityId: input.entityId,
        status: input.status,
        resolvedMessage: input.resolvedMessage ?? '',
      },
    });
  } catch {
    // onFailure already logged; best-effort.
  }
}

// Appeal-resolution email to the appellant (best-effort). `resolvedMessage` is intentionally NOT emailed —
// only the decision + the affected item links. Takes a LIST of image ids so a bulk resolution emails the
// user once, listing every item, instead of one email per image (matching the legacy per-user dedup).
export async function emailAppealResolution(input: {
  to: string;
  username: string;
  approved: boolean;
  imageIds: number[];
}): Promise<void> {
  if (!input.imageIds.length) return;
  const base = (env.CIVITAI_APP_URL || 'https://civitai.com').replace(/\/$/, '');
  try {
    await appealResolutionEmail.send({
      to: input.to,
      username: input.username,
      approved: input.approved,
      items: input.imageIds.map((id) => ({ url: `${base}/images/${id}`, label: `Image #${id}` })),
    });
  } catch (e) {
    console.error('emailAppealResolution failed', {
      imageIds: input.imageIds,
      error: (e as Error).message,
    });
  }
}
