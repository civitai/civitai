import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { BLOCK_POST_APP_ID_META_KEY } from '~/server/services/blocks/block-post.logic';
import type {
  AppPostIntentRecord,
  PostIntentManifest,
} from '~/server/services/post-intent/post-intent.logic';
import {
  buildIntentExternalMeta,
  checkManifest,
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
import { getToolByDomain, getToolByName } from '~/server/services/tool.service';
import { scanEntityInBackground } from '~/server/services/text-scan/submit';
import { probeVideoDimensions } from '~/server/services/video-dimensions';
import { SafeFetchError, safeFetch } from '~/server/utils/safe-fetch';
import { constants } from '~/server/common/constants';
import { EntityType, JobQueueType, MediaType } from '~/shared/utils/prisma/enums';
import {
  deleteManyObjects,
  getImageUploadBackend,
  uploadImageBufferToStore,
} from '~/utils/s3-utils';

const APPROVED = 'approved';

export const POST_INTENT_USER_STAGE_LIMIT = { max: 20, windowSeconds: 60 * 60 };
export const POST_INTENT_APP_STAGE_LIMIT = { max: 2000, windowSeconds: 60 * 60 };

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
  app: { name: string; host: string };
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

async function fetchFromApp(url: string, maxBytes: number, allowedContentTypes: string[]) {
  try {
    return await safeFetch(url, {
      maxBytes,
      allowedContentTypes,
      maxRedirects: 0,
      timeoutMs: POST_INTENT_ITEM_TIMEOUT_MS,
      connectTimeoutMs: POST_INTENT_CONNECT_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof SafeFetchError && err.code === 'too_large')
      throw new PostIntentRefusal('too-large', 'A shared file is too large.');
    throw new PostIntentRefusal('fetch-failed', 'Could not load the shared post from the app.');
  }
}

async function deleteStagedObjects(staged: Pick<StagedIntentMedia, 'key'>[]) {
  if (!staged.length) return;
  try {
    const { s3, bucket } = await getImageUploadBackend();
    await deleteManyObjects(
      bucket,
      staged.map((s) => s.key),
      s3
    );
  } catch (err) {
    logToAxiom({
      name: 'post-intent',
      type: 'error',
      message: 'failed to delete staged objects',
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => null);
  }
}

async function stageMediaItem(
  item: PostIntentManifest['media'][number]
): Promise<StagedIntentMedia> {
  const { bytes } = await fetchFromApp(item.url, POST_INTENT_VIDEO_MAX_BYTES, ['']);
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

function toStagedIntent(
  manifestUrl: string,
  record: Pick<AppPostIntentRecord, 'listingName' | 'host'>,
  manifest: PostIntentManifest,
  staged: StagedIntentMedia[]
): StagedIntent {
  return {
    manifestUrl,
    app: { name: record.listingName, host: record.host },
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
  manifestUrl,
  userId,
  now = new Date(),
}: {
  manifestUrl: string;
  userId: number;
  now?: Date;
}): Promise<StagedIntent> {
  const record = await resolveAppForManifestUrl(manifestUrl);
  if (!record)
    throw new PostIntentRefusal('not-approved', 'This share link is not from an approved app.');

  const existing = await dbWrite.postIntentManifest.findUnique({ where: { manifestUrl } });
  if (existing) {
    if (existing.postedAt)
      throw new PostIntentRefusal('already-posted', 'This share has already been posted.');
    const live = existing.claimExpiresAt.getTime() > now.getTime();
    if (live && existing.userId !== userId)
      throw new PostIntentRefusal('claimed', 'Someone else is already posting this share.');
    if (live)
      return toStagedIntent(
        manifestUrl,
        record,
        existing.manifest as PostIntentManifest,
        existing.staged as StagedIntentMedia[]
      );
    await releaseClaim(existing.id, existing.staged as StagedIntentMedia[]);
  }

  await checkStageRateLimit(`user:${userId}`, POST_INTENT_USER_STAGE_LIMIT);
  await checkStageRateLimit(`app:${record.appId}`, POST_INTENT_APP_STAGE_LIMIT);

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
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
      throw new PostIntentRefusal('claimed', 'Someone else is already posting this share.');
    throw err;
  }
  return toStagedIntent(manifestUrl, record, manifest, staged);
}

async function releaseClaim(id: number, staged: StagedIntentMedia[]) {
  const { count } = await dbWrite.postIntentManifest.deleteMany({
    where: { id, postedAt: null },
  });
  if (count) await deleteStagedObjects(staged);
}

async function resolveToolId(record: AppPostIntentRecord) {
  return (
    (await getToolByName(record.listingName))?.id ??
    (await getToolByDomain(`https://${record.host}/`))?.id
  );
}

/**
 * Turn a staged manifest into a post owned by `userId`, stamped with the app's id. `publish: false`
 * creates the same post as a draft for the editor. The manifest URL can produce one post only.
 */
export async function publishIntent({
  manifestUrl,
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
  const tagIds = tags?.length
    ? Object.values(await findOrCreateTagsByName(tags)).filter((t): t is number => t !== undefined)
    : [];

  const { createImage } = await import('~/server/services/image.service');
  const imageIds: number[] = [];
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
  const post = await dbWrite.$transaction(async (tx) => {
    const created = await tx.post.create({
      data: {
        userId,
        title: title || null,
        detail: description || null,
        publishedAt,
        metadata: { [BLOCK_POST_APP_ID_META_KEY]: record.appId },
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
      where: { id: claim.id, userId, postedAt: null },
      data: { postId: created.id, postedAt: now },
    });
    if (marked.count !== 1)
      throw new PostIntentRefusal('already-posted', 'This share has already been posted.');

    if (publish)
      await tx.$executeRaw`
        INSERT INTO "JobQueue" ("entityId", "entityType", "type")
        VALUES (${created.id}::integer, ${EntityType.Post}::"EntityType", ${JobQueueType.UpdateNsfwLevel}::"JobQueueType")
        ON CONFLICT DO NOTHING
      `;
    return created;
  });

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

/** Release unposted claims whose time has run out and delete their stored files. */
export async function sweepExpiredIntentClaims(now = new Date(), batch = 200) {
  const expired = await dbWrite.postIntentManifest.findMany({
    where: { postedAt: null, claimExpiresAt: { lt: now } },
    select: { id: true, staged: true },
    take: batch,
  });
  for (const row of expired) await releaseClaim(row.id, row.staged as StagedIntentMedia[]);
  return expired.length;
}
