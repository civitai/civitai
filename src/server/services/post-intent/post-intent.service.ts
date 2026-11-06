import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { sanitizeAppChromeName } from '~/components/AppBlocks/appChromeName';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { delIfValue } from '~/server/redis/atomic';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import {
  BLOCK_POST_APP_ID_META_KEY,
  BLOCK_POST_SUB_LISTING_ID_META_KEY,
} from '~/server/services/blocks/block-post.logic';
import type {
  AppPostIntentRecord,
  PostIntentManifest,
} from '~/server/services/post-intent/post-intent.logic';
import {
  buildIntentExternalMeta,
  canonicalManifestUrl,
  checkManifest,
  isHeifBrand,
  matchAppRecord,
  maxBytesFor,
  POST_INTENT_CLAIM_TTL_MS,
  POST_INTENT_CONNECT_TIMEOUT_MS,
  POST_INTENT_ITEM_TIMEOUT_MS,
  POST_INTENT_MANIFEST_MAX_BYTES,
  POST_INTENT_VIDEO_MAX_BYTES,
  PostIntentRefusal,
  sniffIntentMedia,
} from '~/server/services/post-intent/post-intent.logic';
import { findOrCreateTagsByName } from '~/server/services/tag.service';
import { getToolByDomain } from '~/server/services/tool.service';
import { scanEntityInBackground } from '~/server/services/text-scan/submit';
import { probeVideoDimensions } from '~/server/services/video-dimensions';
import { SafeFetchError, safeFetch } from '~/server/utils/safe-fetch';
import { ratingAllowedOnHost } from '~/server/utils/server-domain';
import { constants } from '~/server/common/constants';
import { effectiveSubListingRating } from '~/shared/constants/app-sub-listing.constants';
import { plainTextToPostHtml } from '~/shared/utils/post-intent';
import { EntityType, JobQueueType, MediaType } from '~/shared/utils/prisma/enums';
import {
  deleteManyObjects,
  getImageUploadBackend,
  uploadImageBufferToStore,
} from '~/utils/s3-utils';

const APPROVED = 'approved';

export const POST_INTENT_USER_STAGE_LIMIT = { max: 20, windowSeconds: 60 * 60 };
export const POST_INTENT_APP_STAGE_LIMIT = { max: 2000, windowSeconds: 60 * 60 };
const STAGE_LOCK_SECONDS = 30 * 60;
const SWEEP_BUDGET_MS = 4 * 60 * 1000;

export type StagedIntentMedia = {
  key: string;
  sourceUrl: string;
  type: 'image' | 'video';
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
};

export type StagedIntent = {
  manifestUrl: string;
  app: { name: string; host: string; itemName?: string };
  title?: string;
  description?: string;
  tags: string[];
  returnUrl?: string;
  media: { url: string; type: 'image' | 'video' }[];
};

function isMissingTable(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2021';
}

/**
 * The approval record that covers `manifestUrl`: an enabled per-app row on an approved, current
 * store listing whose host and path prefix contain the URL. The app id is the listing's client.
 */
export async function resolveAppForManifestUrl(
  manifestUrl: string
): Promise<AppPostIntentRecord | null> {
  let host: string;
  try {
    host = new URL(manifestUrl).hostname;
  } catch {
    return null;
  }
  let rows;
  try {
    rows = await dbRead.appPostIntent.findMany({
      where: { host, enabled: true },
      select: { listingId: true, host: true, pathPrefix: true },
    });
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
  const match = matchAppRecord(manifestUrl, rows);
  if (!match) return null;

  const listing = await dbRead.appListing.findFirst({
    where: { id: match.listingId, status: APPROVED, revisionOfId: null },
    select: { name: true, connectClientId: true, appBlock: { select: { appId: true } } },
  });
  const appId = listing?.connectClientId ?? listing?.appBlock?.appId;
  if (!listing || !appId) return null;
  return { ...match, listingName: listing.name, appId };
}

/**
 * The approved sub-listing `item` names under the app's own listing, or null. Never throws: an
 * item that does not resolve leaves the post credited to the app alone.
 */
export async function resolveIntentItem(
  record: Pick<AppPostIntentRecord, 'listingId'>,
  item: string | undefined
): Promise<{ id: string; title: string; rating: string | null } | null> {
  if (!item) return null;
  try {
    const row = await dbRead.appSubListing.findFirst({
      where: {
        parentListingId: record.listingId,
        itemKey: item,
        status: APPROVED,
        author: { bannedAt: null, deletedAt: null },
        parentListing: { subListingParent: { is: { enabled: true } } },
      },
      select: {
        id: true,
        title: true,
        contentRating: true,
        parentListing: { select: { contentRating: true } },
      },
    });
    return (
      row && {
        id: row.id,
        title: sanitizeAppChromeName(row.title) ?? '',
        rating: effectiveSubListingRating(row.parentListing.contentRating, row.contentRating),
      }
    );
  } catch (err) {
    logToAxiom({
      name: 'post-intent',
      type: 'error',
      message: 'failed to resolve item',
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => null);
    return null;
  }
}

async function checkStageRateLimit(key: string, limit: { max: number; windowSeconds: number }) {
  const redisKey = `${REDIS_KEYS.POST_INTENT.RATE_LIMIT}:${key}` as never;
  let count: number;
  try {
    count = await redis.incrBy(redisKey, 1);
    if (count === 1) await redis.expire(redisKey, limit.windowSeconds);
  } catch {
    count = Infinity;
  }
  if (count > limit.max)
    throw new PostIntentRefusal('rate-limited', 'Too many shares right now. Try again later.');
}

/** Holds `key` for one staging at a time; returns a release function, or null if it is held. */
async function acquireStageLock(key: string): Promise<(() => Promise<void>) | null> {
  const redisKey = `${REDIS_KEYS.POST_INTENT.RATE_LIMIT}:lock:${key}` as never;
  const token = randomUUID();
  const acquired = await redis
    .set(redisKey, token, { NX: true, EX: STAGE_LOCK_SECONDS })
    .catch(() => null);
  if (!acquired) return null;
  return async () => {
    await delIfValue(redis, redisKey, token).catch(() => null);
  };
}

function toCanonical(manifestUrl: string) {
  const canonical = canonicalManifestUrl(manifestUrl);
  if (!canonical) throw new PostIntentRefusal('bad-manifest', 'The share link is not valid.');
  return canonical;
}

async function fetchFromApp(
  url: string,
  maxBytes: number,
  allowedContentTypes: string[],
  capFromHead?: Parameters<typeof safeFetch>[1]['capFromHead']
) {
  try {
    return await safeFetch(url, {
      maxBytes,
      allowedContentTypes,
      maxRedirects: 0,
      timeoutMs: POST_INTENT_ITEM_TIMEOUT_MS,
      connectTimeoutMs: POST_INTENT_CONNECT_TIMEOUT_MS,
      capFromHead,
    });
  } catch (err) {
    if (err instanceof SafeFetchError && err.code === 'too_large')
      throw new PostIntentRefusal('too-large', 'A shared file is too large.');
    throw new PostIntentRefusal('fetch-failed', 'Could not load the shared post from the app.');
  }
}

async function deleteStagedObjects(staged: Pick<StagedIntentMedia, 'key'>[]): Promise<boolean> {
  if (!staged.length) return true;
  try {
    const { s3, bucket } = await getImageUploadBackend();
    await deleteManyObjects(
      bucket,
      staged.map((s) => s.key),
      s3
    );
    return true;
  } catch (err) {
    logToAxiom({
      name: 'post-intent',
      type: 'error',
      message: 'failed to delete staged objects',
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => null);
    return false;
  }
}

async function stageMediaItem(
  item: PostIntentManifest['media'][number]
): Promise<StagedIntentMedia> {
  const { bytes } = await fetchFromApp(item.url, POST_INTENT_VIDEO_MAX_BYTES, [''], {
    headBytes: 16,
    maxBytes: (head) => maxBytesFor(sniffIntentMedia(head)?.type ?? 'image'),
  });
  if (isHeifBrand(bytes))
    throw new PostIntentRefusal(
      'unsupported-media',
      'HEIC and AVIF images are not supported. Share JPEG, PNG, WebP or GIF.'
    );
  const sniffed = sniffIntentMedia(bytes);
  if (!sniffed)
    throw new PostIntentRefusal('unsupported-media', 'A shared file is not a supported type.');
  if (bytes.byteLength > maxBytesFor(sniffed.type))
    throw new PostIntentRefusal('too-large', 'A shared file is too large.');

  let width: number | undefined;
  let height: number | undefined;
  if (sniffed.type === 'image') {
    const sharp = (await import('sharp')).default;
    try {
      ({ width, height } = await sharp(bytes).metadata());
    } catch {
      throw new PostIntentRefusal('unsupported-media', 'A shared file is not a supported type.');
    }
  }

  const { key } = await uploadImageBufferToStore(bytes, { contentType: sniffed.mimeType });
  const staged: StagedIntentMedia = {
    key,
    sourceUrl: item.url,
    type: sniffed.type,
    mimeType: sniffed.mimeType,
    size: bytes.byteLength,
    width,
    height,
  };

  if (sniffed.type === 'video') {
    const dims = await probeVideoDimensions(key);
    const { maxVideoDurationSeconds, maxVideoDimension } = constants.mediaUpload;
    if (
      !dims ||
      !dims.duration ||
      dims.duration > maxVideoDurationSeconds ||
      dims.width > maxVideoDimension ||
      dims.height > maxVideoDimension
    ) {
      await deleteStagedObjects([staged]);
      throw new PostIntentRefusal(
        'video-limits',
        `Videos must be at most ${maxVideoDurationSeconds} seconds and ${maxVideoDimension}px.`
      );
    }
    staged.width = dims.width;
    staged.height = dims.height;
  }
  return staged;
}

/** `requestHost` hides a mature item's name where the post's chip would hide the item. */
async function toStagedIntent(
  manifestUrl: string,
  record: Pick<AppPostIntentRecord, 'listingId' | 'listingName' | 'host'>,
  manifest: PostIntentManifest,
  staged: StagedIntentMedia[],
  requestHost: string
): Promise<StagedIntent> {
  const item = await resolveIntentItem(record, manifest.item);
  return {
    manifestUrl,
    app: {
      name: record.listingName,
      host: record.host,
      ...(item?.title && ratingAllowedOnHost(item.rating, requestHost) && { itemName: item.title }),
    },
    title: manifest.title,
    description: manifest.description,
    tags: manifest.tags ?? [],
    returnUrl: manifest.returnUrl,
    media: staged.map((s) => ({ url: s.sourceUrl, type: s.type })),
  };
}

/**
 * Fetch an approved app's manifest and its media, store the files, and claim the manifest URL for
 * this user. Nothing is visible on the site until {@link publishIntent} creates the post.
 */
export async function stageIntent({
  manifestUrl: rawManifestUrl,
  userId,
  requestHost = '',
  now = new Date(),
}: {
  manifestUrl: string;
  userId: number;
  /** The site host the user is on; absent, a mature item goes unnamed. */
  requestHost?: string;
  now?: Date;
}): Promise<StagedIntent> {
  const manifestUrl = toCanonical(rawManifestUrl);
  const record = await resolveAppForManifestUrl(manifestUrl);
  if (!record)
    throw new PostIntentRefusal('not-approved', 'This share link is not from an approved app.');

  const existing = await dbWrite.postIntentManifest.findUnique({ where: { manifestUrl } });
  if (existing) {
    const resumed = await resumeClaim(existing, manifestUrl, userId, now, record, requestHost);
    if (resumed) return resumed;
    if (!(await releaseClaim(existing.id, existing.staged as StagedIntentMedia[]))) {
      const after = await dbWrite.postIntentManifest.findUnique({ where: { manifestUrl } });
      if (after?.postedAt)
        throw new PostIntentRefusal('already-posted', 'This share has already been posted.');
      if (after)
        throw new PostIntentRefusal('busy', 'This share is still being cleared. Try again later.');
    }
  }

  const releaseUser = await acquireStageLock(`user:${userId}`);
  if (!releaseUser)
    throw new PostIntentRefusal('busy', 'Another share is still loading. Try again in a moment.');
  const releaseUrl = await acquireStageLock(`url:${manifestUrl}`);
  try {
    if (!releaseUrl)
      throw new PostIntentRefusal('busy', 'This share is still loading. Try again in a moment.');
    await checkStageRateLimit(`user:${userId}`, POST_INTENT_USER_STAGE_LIMIT);
    return await fetchAndStage({ manifestUrl, record, userId, requestHost, now });
  } finally {
    await releaseUser();
    await releaseUrl?.();
  }
}

type ManifestRow = {
  id: number;
  userId: number;
  postedAt: Date | null;
  claimExpiresAt: Date;
  manifest: unknown;
  staged: unknown;
};

/** The staged intent to hand back when `userId` reopens a live claim of their own. */
async function resumeClaim(
  row: ManifestRow,
  manifestUrl: string,
  userId: number,
  now: Date,
  record: AppPostIntentRecord,
  requestHost: string
): Promise<StagedIntent | null> {
  if (row.postedAt)
    throw new PostIntentRefusal('already-posted', 'This share has already been posted.');
  const live = row.claimExpiresAt.getTime() > now.getTime();
  if (live && row.userId !== userId)
    throw new PostIntentRefusal('claimed', 'Someone else is already posting this share.');
  if (!live) return null;
  return toStagedIntent(
    manifestUrl,
    record,
    row.manifest as PostIntentManifest,
    row.staged as StagedIntentMedia[],
    requestHost
  );
}

async function fetchAndStage({
  manifestUrl,
  record,
  userId,
  requestHost,
  now,
}: {
  manifestUrl: string;
  record: AppPostIntentRecord;
  userId: number;
  requestHost: string;
  now: Date;
}): Promise<StagedIntent> {
  const { bytes } = await fetchFromApp(manifestUrl, POST_INTENT_MANIFEST_MAX_BYTES, [
    'application/json',
  ]);
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new PostIntentRefusal('bad-manifest', 'The share link is not valid.');
  }
  const manifest = checkManifest(json, record, now);
  await checkStageRateLimit(`app:${record.appId}`, POST_INTENT_APP_STAGE_LIMIT);

  const staged: StagedIntentMedia[] = [];
  try {
    for (const item of manifest.media) staged.push(await stageMediaItem(item));
    await dbWrite.postIntentManifest.create({
      data: {
        manifestUrl,
        appId: record.appId,
        listingId: record.listingId,
        userId,
        manifest: manifest as Prisma.InputJsonObject,
        staged: staged as unknown as Prisma.InputJsonArray,
        claimExpiresAt: new Date(now.getTime() + POST_INTENT_CLAIM_TTL_MS),
      },
    });
  } catch (err) {
    await deleteStagedObjects(staged);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await dbWrite.postIntentManifest.findUnique({ where: { manifestUrl } });
      const resumed =
        winner && (await resumeClaim(winner, manifestUrl, userId, now, record, requestHost));
      if (resumed) return resumed;
      throw new PostIntentRefusal('claimed', 'Someone else is already posting this share.');
    }
    throw err;
  }
  return toStagedIntent(manifestUrl, record, manifest, staged, requestHost);
}

/**
 * Release an unposted claim: mark it released so it can no longer be published, delete its stored
 * files, then delete the row. The row stays (released) if the files could not be deleted, so the
 * sweep retries rather than orphaning them.
 */
async function releaseClaim(id: number, staged: StagedIntentMedia[]): Promise<boolean> {
  const { count } = await dbWrite.postIntentManifest.updateMany({
    where: { id, postedAt: null },
    data: { claimExpiresAt: new Date(0) },
  });
  if (!count) return false;
  if (!(await deleteStagedObjects(staged))) return false;
  const deleted = await dbWrite.postIntentManifest.deleteMany({ where: { id, postedAt: null } });
  return deleted.count === 1;
}

async function resolveToolId(record: AppPostIntentRecord) {
  return (await getToolByDomain(`https://${record.host}/`))?.id;
}

/**
 * Turn a staged manifest into a post owned by `userId`, stamped with the app's id. `publish: false`
 * creates the same post as a draft for the editor. The manifest URL can produce one post only.
 */
export async function publishIntent({
  manifestUrl: rawManifestUrl,
  userId,
  title,
  description,
  tags,
  publish,
  now = new Date(),
}: {
  manifestUrl: string;
  userId: number;
  title?: string | null;
  description?: string | null;
  tags?: string[];
  publish: boolean;
  now?: Date;
}): Promise<{ postId: number; returnUrl?: string }> {
  const manifestUrl = toCanonical(rawManifestUrl);
  const claim = await dbWrite.postIntentManifest.findUnique({ where: { manifestUrl } });
  if (claim?.postedAt)
    throw new PostIntentRefusal('already-posted', 'This share has already been posted.');
  if (!claim || claim.userId !== userId || claim.claimExpiresAt.getTime() <= now.getTime())
    throw new PostIntentRefusal('not-staged', 'Open the share link again to continue.');

  const record = await resolveAppForManifestUrl(manifestUrl);
  if (!record || record.appId !== claim.appId)
    throw new PostIntentRefusal('not-approved', 'This share link is not from an approved app.');

  await throwOnBlockedUserContent([title, description], { surface: 'post' });

  const manifest = claim.manifest as PostIntentManifest;
  const staged = claim.staged as StagedIntentMedia[];
  const external = buildIntentExternalMeta(manifest, record);
  const toolId = await resolveToolId(record);
  const item = await resolveIntentItem(record, manifest.item);
  const tagIds = tags?.length
    ? Object.values(await findOrCreateTagsByName(tags)).filter((t): t is number => t !== undefined)
    : [];

  const detail = description ? plainTextToPostHtml(description) : null;
  const { createImage } = await import('~/server/services/image.service');
  const imageIds: number[] = [];
  let post: { id: number };
  try {
    for (const item of staged) {
      const image = await createImage({
        url: item.key,
        type: item.type === 'video' ? MediaType.video : MediaType.image,
        mimeType: item.mimeType,
        width: item.width,
        height: item.height,
        metadata: { size: item.size },
        meta: { external } as never,
        toolIds: toolId ? [toolId] : undefined,
        userId,
      });
      imageIds.push(image.id);
    }

    const publishedAt = publish ? now : null;
    post = await dbWrite.$transaction(async (tx) => {
      const created = await tx.post.create({
        data: {
          userId,
          title: title || null,
          detail,
          publishedAt,
          metadata: {
            [BLOCK_POST_APP_ID_META_KEY]: record.appId,
            ...(item && { [BLOCK_POST_SUB_LISTING_ID_META_KEY]: item.id }),
          },
          tags: tagIds.length ? { create: tagIds.map((tagId) => ({ tagId })) } : undefined,
        },
        select: { id: true },
      });

      for (let index = 0; index < imageIds.length; index++) {
        const adopted = await tx.image.updateMany({
          where: { id: imageIds[index], userId, postId: null },
          data: { postId: created.id, index },
        });
        if (adopted.count !== 1)
          throw new PostIntentRefusal('not-staged', 'Open the share link again to continue.');
      }

      const marked = await tx.postIntentManifest.updateMany({
        where: { id: claim.id, userId, postedAt: null, claimExpiresAt: { gt: new Date() } },
        data: { postId: created.id, postedAt: now },
      });
      if (marked.count !== 1) {
        const current = await tx.postIntentManifest.findUnique({ where: { id: claim.id } });
        if (current?.postedAt)
          throw new PostIntentRefusal('already-posted', 'This share has already been posted.');
        throw new PostIntentRefusal('not-staged', 'Open the share link again to continue.');
      }

      if (publish)
        await tx.$executeRaw`
          INSERT INTO "JobQueue" ("entityId", "entityType", "type")
          VALUES (${created.id}::integer, ${EntityType.Post}::"EntityType", ${JobQueueType.UpdateNsfwLevel}::"JobQueueType")
          ON CONFLICT DO NOTHING
        `;
      return created;
    });
  } catch (err) {
    if (imageIds.length)
      await dbWrite.image
        .deleteMany({ where: { id: { in: imageIds }, userId, postId: null } })
        .catch(() => null);
    throw err;
  }

  if (publish) {
    if (title || description) scanEntityInBackground({ entityType: 'Post', entityId: post.id });
    const { applyBlockPostPublishEffects } = await import(
      '~/server/services/blocks/block-post.service'
    );
    await applyBlockPostPublishEffects({
      postId: post.id,
      userId,
      imageIds,
      modelVersionId: null,
      modelId: null,
    }).catch((err) =>
      logToAxiom({
        name: 'post-intent',
        type: 'error',
        message: 'publish effects failed',
        postId: post.id,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => null)
    );
  }

  return { postId: post.id, returnUrl: publish ? manifest.returnUrl : undefined };
}

/** Release unposted claims whose time has run out, in batches, within a time budget. */
export async function sweepExpiredIntentClaims(now = new Date(), batch = 200) {
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  let released = 0;
  let lastId = 0;
  while (Date.now() < deadline) {
    let expired;
    try {
      expired = await dbWrite.postIntentManifest.findMany({
        where: { id: { gt: lastId }, postedAt: null, claimExpiresAt: { lt: now } },
        select: { id: true, staged: true },
        orderBy: { id: 'asc' },
        take: batch,
      });
    } catch (err) {
      if (isMissingTable(err)) return released;
      throw err;
    }
    for (const row of expired) await releaseClaim(row.id, row.staged as StagedIntentMedia[]);
    released += expired.length;
    if (expired.length < batch) break;
    lastId = expired[expired.length - 1].id;
  }
  return released;
}
