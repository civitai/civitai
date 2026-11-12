import { Prisma } from '@prisma/client';
import { CacheTTL } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { imageReviewedSql } from '~/server/common/image-visibility';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLagBatch, preventReplicationLagBatch } from '~/server/db/db-lag-helpers';
import { logToAxiom } from '~/server/logging/client';
import { notBlockedBetween } from '~/server/notifications/base.notifications';
import { REDIS_KEYS } from '~/server/redis/client';
import type { ImagesForModelVersions } from '~/server/services/image.service';
import { imageBlockedForConditions } from '~/server/services/image-visibility.service';
import { createCachedObject } from '~/server/utils/cache-helpers';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { imageOnSiteSql } from '~/server/utils/image-onsite';
import {
  nsfwBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  coverColumnForSite,
  VERSION_SHOWCASE_LIMIT,
  type VersionShowcaseSite,
} from '~/shared/constants/version-showcase.constants';
import { Flags } from '~/shared/utils/flags';

export type VersionShowcaseRow = {
  imageId: number;
  site: VersionShowcaseSite;
  source: 'Owner' | 'Community';
  position: number | null;
  excluded: boolean;
};

export type VersionShowcaseCommunityImage = ImagesForModelVersions & {
  site: VersionShowcaseSite;
  authorUsername: string | null;
};

type CachedVersionShowcase = {
  modelVersionId: number;
  rows: VersionShowcaseRow[];
  /** Community rows that pass every filter today, as image rows ready to serve. */
  community: VersionShowcaseCommunityImage[];
};

/**
 * The conditions an image must meet to be served from a version showcase, the same ones the owner
 * showcase applies to its shared cache (getImagesForModelVersion with no viewer): published post,
 * not blocked, not a TOS violation, not waiting on review, rated, reviewed, and no mature image on
 * a restricted base model.
 */
export function showcaseImageConditions(): Prisma.Sql[] {
  return [
    Prisma.sql`p."publishedAt" IS NOT NULL`,
    Prisma.sql`i."tosViolation" = FALSE`,
    ...imageBlockedForConditions({}),
    Prisma.sql`i."needsReview" IS NULL AND i."acceptableMinor" = FALSE`,
    Prisma.sql`i."nsfwLevel" != 0`,
    imageReviewedSql(),
    Prisma.sql`((i."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0 OR NOT i."modelRestricted")`,
  ];
}

/**
 * The extra conditions on someone else's image: its post is public, its author is active, has not
 * opted out and isn't hidden from the creator's galleries, neither of them blocks the other, and a
 * .com row holds only an image rated PG or PG-13.
 */
function communityImageConditions(): Prisma.Sql[] {
  return [
    Prisma.sql`p.availability = 'Public'`,
    Prisma.sql`u."bannedAt" IS NULL AND u."deletedAt" IS NULL`,
    Prisma.sql`COALESCE((u.settings->>'hideFromVersionShowcases')::boolean, FALSE) = FALSE`,
    // The same list `getCreatorGalleryHiddenUserIds` reads, inlined for this batched join.
    Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "CreatorGalleryHiddenUser" cgh
      WHERE cgh."creatorId" = m."userId" AND cgh."userId" = i."userId"
    )`,
    Prisma.raw(notBlockedBetween('i."userId"', 'm."userId"')),
    Prisma.sql`(s.site <> 'com' OR (i."nsfwLevel" & ${sfwBrowsingLevelsFlag}) = i."nsfwLevel")`,
  ];
}

let versionShowcaseCacheInstance: ReturnType<typeof buildVersionShowcaseCache> | undefined;
/** The version showcase cache, built on first use. */
export const getVersionShowcaseCache = () =>
  (versionShowcaseCacheInstance ??= buildVersionShowcaseCache());

const buildVersionShowcaseCache = () =>
  createCachedObject<CachedVersionShowcase>({
    key: REDIS_KEYS.CACHES.VERSION_SHOWCASE,
    idKey: 'modelVersionId',
    // A backstop for any moderation transition a bust misses.
    ttl: CacheTTL.hour,
    lookupFn: async (ids, fromWrite) => {
      const db = fromWrite ? dbWrite : await getDbWithoutLagBatch('modelVersion', ids);
      const records: Record<number, CachedVersionShowcase> = {};
      // Every id gets a record, so "this version has no showcase rows" is cached too.
      for (const id of ids) records[id] = { modelVersionId: id, rows: [], community: [] };

      const rows = await db.$queryRaw<(VersionShowcaseRow & { modelVersionId: number })[]>`
      SELECT s."modelVersionId", s."imageId", s.site, s.source, s.position, s.excluded
      FROM "ModelVersionShowcaseItem" s
      WHERE s."modelVersionId" IN (${Prisma.join(ids)})
        AND NOT s."removedByContributor"
    `;
      for (const row of rows) records[row.modelVersionId].rows.push(row);

      const withCommunity = [
        ...new Set(rows.filter((r) => r.source === 'Community').map((r) => r.modelVersionId)),
      ];
      if (!withCommunity.length) return records;

      const community = await db.$queryRaw<
        (VersionShowcaseCommunityImage & { galleryHiddenUserIds: number[] | null })[]
      >`
      SELECT
        i.id, i."userId", i.name, i.url, i."nsfwLevel", i.width, i.height, i.hash, i.type,
        i.metadata, i.minor, i.poi,
        s."modelVersionId", s.site,
        u.username AS "authorUsername",
        p."availability",
        (i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta") AS "hasMeta",
        (
          i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
          AND i.meta->>'prompt' IS NOT NULL
        ) AS "hasPositivePrompt",
        ${imageOnSiteSql()} AS "onSite",
        i."meta"->'extra'->'remixOfId' AS "remixOfId"
      FROM "ModelVersionShowcaseItem" s
      JOIN "ModelVersion" mv ON mv.id = s."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      JOIN "Image" i ON i.id = s."imageId"
      JOIN "Post" p ON p.id = i."postId"
      JOIN "User" u ON u.id = i."userId"
      WHERE s."modelVersionId" IN (${Prisma.join(withCommunity)})
        AND s.source = 'Community'
        AND NOT s."removedByContributor"
        AND ${Prisma.join([...showcaseImageConditions(), ...communityImageConditions()], ' AND ')}
    `;
      if (!community.length) return records;

      // The model's own gallery rules (hidden users and images, the held level of a minor or SFW-only
      // model) apply here as they do to its gallery.
      const { getGallerySettingsByModelId } = await import('~/server/services/model.service');
      const versionModels = await db.modelVersion.findMany({
        where: { id: { in: withCommunity } },
        select: { id: true, modelId: true },
      });
      const modelOf = new Map(versionModels.map((v) => [v.id, v.modelId]));
      const settings = new Map(
        await Promise.all(
          [...new Set(modelOf.values())].map(
            async (modelId) =>
              [modelId, await getGallerySettingsByModelId({ id: modelId })] as const
          )
        )
      );

      for (const image of community) {
        const gallery = settings.get(modelOf.get(image.modelVersionId) ?? -1);
        if (passesGalleryRules(gallery, image)) records[image.modelVersionId].community.push(image);
      }
      return records;
    },
  });

type GallerySettings = {
  hiddenUsers?: { id: number }[];
  hiddenImages?: Record<string | number, number[]>;
  sfwHeld?: boolean;
  level?: number;
} | null;

/** The model's own gallery rules: hidden users and images, and the held level of a minor or
 *  SFW-only model. */
function passesGalleryRules(
  gallery: GallerySettings | undefined,
  image: { id: number; userId: number; nsfwLevel: number; modelVersionId: number }
) {
  if (gallery?.hiddenUsers?.some((user) => user.id === image.userId)) return false;
  if (gallery?.hiddenImages?.[image.modelVersionId]?.includes(image.id)) return false;
  if (gallery?.sfwHeld && !Flags.intersects(gallery.level ?? 0, image.nsfwLevel)) return false;
  return true;
}

export async function getVersionShowcases(modelVersionIds: number[]) {
  if (!modelVersionIds.length) return {} as Record<number, CachedVersionShowcase>;
  return getVersionShowcaseCache().fetch(modelVersionIds);
}

/**
 * The carousel's image ids for one version and site when the creator has curated it, or null when
 * they haven't (or the showcase can't be read), in which case the carousel keeps today's list.
 *
 * Order: the model's cover for that site when it is in this list, then positioned items, then the
 * owner's remaining images in their usual order. Excluded owner images are left out. Capped at the
 * carousel's limit.
 */
export async function getVersionShowcaseImageIds({
  modelVersionId,
  site,
  ownerImageIds,
  coverImageId,
}: {
  modelVersionId: number;
  site: VersionShowcaseSite;
  ownerImageIds: number[];
  coverImageId: number | null;
}): Promise<number[] | null> {
  try {
    const entry = (await getVersionShowcases([modelVersionId]))[modelVersionId];
    const rows = entry?.rows.filter((row) => row.site === site) ?? [];
    if (!rows.length) return null;

    const excluded = new Set(rows.filter((row) => row.excluded).map((row) => row.imageId));
    const community = new Set(
      entry.community.filter((image) => image.site === site).map((image) => image.id)
    );
    // The owner cache holds the first 20; an owner image positioned further down comes from its row
    // (the carousel's hydrate re-checks every id against the viewer's filters).
    const ownerRows = rows.filter((row) => row.source === 'Owner').map((row) => row.imageId);
    const owner = [...new Set([...ownerImageIds, ...ownerRows])].filter((id) => !excluded.has(id));
    const available = new Set([...owner, ...community]);
    const position = new Map(
      rows
        .filter((row) => row.position !== null && available.has(row.imageId))
        .map((row) => [row.imageId, row.position as number])
    );

    const ordered = [
      ...(coverImageId && available.has(coverImageId) ? [coverImageId] : []),
      ...[...position.entries()].sort((a, b) => a[1] - b[1]).map(([imageId]) => imageId),
      ...owner.filter((id) => !position.has(id)),
    ];
    return [...new Set(ordered)].slice(0, VERSION_SHOWCASE_LIMIT);
  } catch (error) {
    void logToAxiom(
      {
        type: 'error',
        name: 'version-showcase-read-failed',
        modelVersionId,
        message: (error as Error).message,
      },
      'civitai-prod'
    ).catch(() => undefined);
    return null;
  }
}

/**
 * The carousel's ids for a version on a site, or null when the creator hasn't curated it there.
 * Reads only the showcase cache for an uncurated version; the owner list and the model's cover are
 * read only when there is something to merge them with.
 */
export async function getCarouselShowcaseIds({
  modelVersionId,
  site,
}: {
  modelVersionId: number;
  site: VersionShowcaseSite;
}) {
  try {
    const entry = (await getVersionShowcases([modelVersionId]))[modelVersionId];
    if (!entry?.rows.some((row) => row.site === site)) return null;
    const { imagesForModelVersionsCache } = await import('~/server/services/image.service');
    const [owner, version] = await Promise.all([
      imagesForModelVersionsCache.fetch([modelVersionId]),
      dbRead.modelVersion.findUnique({
        where: { id: modelVersionId },
        select: { model: { select: { coverImageId: true, sfwCoverImageId: true } } },
      }),
    ]);
    return getVersionShowcaseImageIds({
      modelVersionId,
      site,
      ownerImageIds: owner[modelVersionId]?.images.map((image) => image.id) ?? [],
      coverImageId: version?.model[coverColumnForSite(site)] ?? null,
    });
  } catch (error) {
    void logToAxiom(
      {
        type: 'error',
        name: 'version-showcase-read-failed',
        modelVersionId,
        message: (error as Error).message,
      },
      'civitai-prod'
    ).catch(() => undefined);
    return null;
  }
}

export type ShowcaseCommunityCovers = Map<
  string,
  { image: VersionShowcaseCommunityImage; sites: Set<VersionShowcaseSite> }
>;
const coverKey = (modelId: number, imageId: number) => `${modelId}:${imageId}`;

/**
 * Community images of a model that may serve as its cover: each (model, image) with a live showcase
 * row on any of that model's versions, whose image still exists and passes the showcase filters,
 * with its image row and the sites it is featured on. Covers set on an older version stay valid
 * after a new version publishes. Look results up with `isShowcaseCoverImage`.
 */
export async function getShowcaseCommunityCovers(
  covers: { modelId: number; imageId: number }[],
  { primary = false }: { primary?: boolean } = {}
): Promise<ShowcaseCommunityCovers> {
  const found: ShowcaseCommunityCovers = new Map();
  if (!covers.length) return found;
  try {
    return await findShowcaseCommunityCovers(covers, primary, found);
  } catch (error) {
    // Validation (primary) fails closed; a reader drawing a card falls back to the default cover.
    if (primary) throw error;
    logShowcaseError('version-showcase-cover-read-failed', error);
    return found;
  }
}

/** The one rule for whether a community image is a valid cover of this model on this site. */
export function isShowcaseCoverImage(
  covers: ShowcaseCommunityCovers,
  { modelId, imageId, site }: { modelId: number; imageId: number; site: VersionShowcaseSite }
) {
  const entry = covers.get(coverKey(modelId, imageId));
  return entry?.sites.has(site) ? entry.image : undefined;
}

async function findShowcaseCommunityCovers(
  covers: { modelId: number; imageId: number }[],
  primary: boolean,
  found: ShowcaseCommunityCovers
) {
  const db = primary ? dbWrite : dbRead;
  // Joined to Image, so a deleted image stops counting at once rather than when the cache expires.
  const versions = await db.$queryRaw<
    { modelVersionId: number; modelId: number; imageId: number }[]
  >`
    SELECT DISTINCT s."modelVersionId", mv."modelId", s."imageId"
    FROM "ModelVersionShowcaseItem" s
    JOIN "ModelVersion" mv ON mv.id = s."modelVersionId"
    JOIN "Image" i ON i.id = s."imageId"
    WHERE s."imageId" IN (${Prisma.join(covers.map((cover) => cover.imageId))})
      AND mv."modelId" IN (${Prisma.join(covers.map((cover) => cover.modelId))})
      AND s.source = 'Community'
      AND NOT s."removedByContributor"
  `;
  const wanted = new Set(covers.map((cover) => coverKey(cover.modelId, cover.imageId)));
  const rows = versions.filter((row) => wanted.has(coverKey(row.modelId, row.imageId)));
  if (!rows.length) return found;
  const versionIds = [...new Set(rows.map((row) => row.modelVersionId))];
  // Validation judges the current state, not a cache a missed bust left behind.
  if (primary) await refreshVersionShowcases(versionIds);
  const showcases = await getVersionShowcases(versionIds);
  for (const { modelVersionId, modelId, imageId } of rows) {
    for (const image of showcases[modelVersionId]?.community ?? []) {
      if (image.id !== imageId) continue;
      const key = coverKey(modelId, imageId);
      const entry = found.get(key) ?? { image, sites: new Set<VersionShowcaseSite>() };
      entry.sites.add(image.site);
      found.set(key, entry);
    }
  }
  return found;
}

function logShowcaseError(name: string, error: unknown) {
  void logToAxiom(
    { type: 'error', name, message: (error as Error)?.message ?? String(error) },
    'civitai-prod'
  ).catch(() => undefined);
}

/** Refreshes the showcase cache for these versions, reading from the primary. */
export async function refreshVersionShowcases(modelVersionIds: number[]) {
  const ids = [...new Set(modelVersionIds)];
  if (!ids.length) return;
  await preventReplicationLagBatch('modelVersion', ids);
  await getVersionShowcaseCache().refresh(ids);
}

/** The versions (and their models) whose showcase names any image in these posts. */
export async function getShowcaseVersionsForPosts(postIds: number[]) {
  if (!postIds.length) return [];
  return dbWrite.$queryRaw<{ modelVersionId: number; modelId: number }[]>`
    SELECT DISTINCT s."modelVersionId", mv."modelId"
    FROM "Image" i
    JOIN "ModelVersionShowcaseItem" s ON s."imageId" = i.id
    JOIN "ModelVersion" mv ON mv.id = s."modelVersionId"
    WHERE i."postId" IN (${Prisma.join(postIds)})
  `;
}

/**
 * Clears any model cover that is a community image no longer allowed there (removed, its author
 * banned, opted out or blocked, the image moderated). Runs after the showcase caches are refreshed,
 * so it judges the current state. The creator's own covers are left alone.
 */
export async function dropInvalidCommunityCovers(modelIds: number[]) {
  const ids = [...new Set(modelIds)];
  if (!ids.length) return;
  const models = await dbWrite.$queryRaw<
    {
      id: number;
      userId: number;
      coverImageId: number | null;
      sfwCoverImageId: number | null;
      coverUserId: number | null;
      sfwCoverUserId: number | null;
    }[]
  >`
    SELECT m.id, m."userId", m."coverImageId", m."sfwCoverImageId",
      ci."userId" AS "coverUserId", si."userId" AS "sfwCoverUserId"
    FROM "Model" m
    LEFT JOIN "Image" ci ON ci.id = m."coverImageId"
    LEFT JOIN "Image" si ON si.id = m."sfwCoverImageId"
    WHERE m.id IN (${Prisma.join(ids)})
  `;
  const candidates = models.flatMap((model) =>
    (
      [
        ['red', model.coverImageId, model.coverUserId],
        ['com', model.sfwCoverImageId, model.sfwCoverUserId],
      ] as const
    )
      .filter(([, imageId, imageUserId]) => imageId && imageUserId && imageUserId !== model.userId)
      .map(([site, imageId]) => ({ modelId: model.id, site, imageId: imageId as number }))
  );
  if (!candidates.length) return;
  const valid = await getShowcaseCommunityCovers(candidates, { primary: true });
  const { saveModelCovers } = await import('~/server/services/model-cover.service');
  for (const { modelId, site, imageId } of candidates) {
    if (isShowcaseCoverImage(valid, { modelId, imageId, site })) continue;
    await saveModelCovers({
      modelId,
      covers: { [coverColumnForSite(site)]: null },
      actorUserId: -1,
      systemReason: 'version-showcase-image-no-longer-eligible',
    });
  }
}

/** Refreshes every showcase holding these posts' images, and drops covers that no longer qualify. */
export async function bustVersionShowcasesForPosts(postIds: number[]) {
  try {
    const affected = await getShowcaseVersionsForPosts(postIds);
    if (!affected.length) return;
    await refreshVersionShowcases(affected.map((row) => row.modelVersionId));
    await dropInvalidCommunityCovers(affected.map((row) => row.modelId));
  } catch (error) {
    // Runs after the write it follows has committed; the hour TTL is the backstop.
    logShowcaseError('version-showcase-bust-failed', error);
  }
}

/**
 * Refreshes every showcase holding a user's images: after a ban, an opt-out, or a block or gallery
 * hide involving them. Starts from the showcase table, which is small, not from the user's images.
 * With `ownerId`, only that creator's models (a block or hide is between two people).
 */
export async function bustVersionShowcasesForUser(userId: number, ownerId?: number) {
  try {
    const affected = await dbWrite.$queryRaw<{ modelVersionId: number; modelId: number }[]>`
      SELECT DISTINCT s."modelVersionId", mv."modelId"
      FROM "ModelVersionShowcaseItem" s
      JOIN "Image" i ON i.id = s."imageId"
      JOIN "ModelVersion" mv ON mv.id = s."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE s.source = 'Community'
        AND i."userId" = ${userId}
        ${ownerId !== undefined ? Prisma.sql`AND m."userId" = ${ownerId}` : Prisma.empty}
    `;
    if (!affected.length) return;
    await refreshVersionShowcases(affected.map((row) => row.modelVersionId));
    await dropInvalidCommunityCovers(affected.map((row) => row.modelId));
  } catch (error) {
    // Runs after the write it follows has committed; the hour TTL is the backstop.
    logShowcaseError('version-showcase-bust-failed', error);
  }
}

/** Refreshes the showcases of these models' versions: after their gallery rules or hold change. */
export async function bustVersionShowcasesForModels(modelIds: number[]) {
  try {
    if (!modelIds.length) return;
    const affected = await dbWrite.$queryRaw<{ modelVersionId: number }[]>`
      SELECT DISTINCT s."modelVersionId"
      FROM "ModelVersionShowcaseItem" s
      JOIN "ModelVersion" mv ON mv.id = s."modelVersionId"
      WHERE mv."modelId" IN (${Prisma.join(modelIds)})
    `;
    if (!affected.length) return;
    await refreshVersionShowcases(affected.map((row) => row.modelVersionId));
    await dropInvalidCommunityCovers(modelIds);
  } catch (error) {
    // Runs after the write it follows has committed; the hour TTL is the backstop.
    logShowcaseError('version-showcase-bust-failed', error);
  }
}

// --- Writes -------------------------------------------------------------------------------------

export type VersionShowcaseItemInput = {
  imageId: number;
  position?: number | null;
  excluded?: boolean;
};

async function getVersionForWrite(modelVersionId: number) {
  const version = await dbWrite.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: {
      id: true,
      status: true,
      model: { select: { id: true, name: true, userId: true, nsfw: true, status: true } },
    },
  });
  if (!version) throw throwNotFoundError('Model version not found');
  return version;
}

function assertCanCurate(model: { userId: number }, userId: number, isModerator: boolean) {
  if (model.userId !== userId && !isModerator)
    throw throwAuthorizationError('Only the model’s creator can edit its showcase.');
}

/** The ids among `imageIds` that are the creator's own published images on this version. */
async function getOwnerImageIds(modelVersionId: number, imageIds: number[]) {
  if (!imageIds.length) return new Set<number>();
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT i.id
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE i.id IN (${Prisma.join(imageIds)})
      AND p."modelVersionId" = ${modelVersionId}
      AND p."userId" = m."userId"
      AND p."publishedAt" IS NOT NULL
  `;
  return new Set(rows.map((row) => row.id));
}

/**
 * The ids among `imageIds` someone else may have featured on this version and site: made with the
 * version or posted to its gallery, and passing every showcase filter today.
 */
async function getEligibleCommunityImages(
  modelVersionId: number,
  site: VersionShowcaseSite,
  imageIds: number[]
) {
  if (!imageIds.length) return [];
  return dbWrite.$queryRaw<{ id: number; userId: number; nsfwLevel: number }[]>`
    SELECT i.id, i."userId", i."nsfwLevel"
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    JOIN "ModelVersion" mv ON mv.id = ${modelVersionId}
    JOIN "Model" m ON m.id = mv."modelId"
    JOIN "User" u ON u.id = i."userId"
    CROSS JOIN (SELECT ${site}::text AS site) s
    WHERE i.id IN (${Prisma.join(imageIds)})
      AND i."userId" <> m."userId"
      AND (
        p."modelVersionId" = mv.id
        OR EXISTS (
          SELECT 1 FROM "ImageResourceNew" ir
          WHERE ir."imageId" = i.id AND ir."modelVersionId" = mv.id
        )
      )
      AND ${Prisma.join([...showcaseImageConditions(), ...communityImageConditions()], ' AND ')}
  `;
}

/**
 * Replaces one version's showcase on one site: the order and hides of the creator's images, and
 * the community images featured. Images their authors removed stay removed. Slot 1 is the model's
 * cover and is set with `setVersionShowcaseCover`, not here.
 */
export async function setVersionShowcase({
  modelVersionId,
  site,
  items,
  userId,
  isModerator,
}: {
  modelVersionId: number;
  site: VersionShowcaseSite;
  items: VersionShowcaseItemInput[];
  userId: number;
  isModerator: boolean;
}) {
  const version = await getVersionForWrite(modelVersionId);
  assertCanCurate(version.model, userId, isModerator);

  const unique = [...new Map(items.map((item) => [item.imageId, item])).values()];
  const ids = unique.map((item) => item.imageId);
  const [ownerIds, tombstones, existing] = await Promise.all([
    getOwnerImageIds(modelVersionId, ids),
    // An author's removal holds on both sites, whichever site the image was featured on.
    dbWrite.modelVersionShowcaseItem.findMany({
      where: { modelVersionId, removedByContributor: true },
      select: { imageId: true },
    }),
    dbWrite.modelVersionShowcaseItem.findMany({
      where: { modelVersionId, removedByContributor: false, source: 'Community' },
      select: { imageId: true },
    }),
  ]);
  const removed = new Set(tombstones.map((row) => row.imageId));
  const communityItems = unique.filter((item) => !ownerIds.has(item.imageId));
  const blockedByAuthor = communityItems.find((item) => removed.has(item.imageId));
  if (blockedByAuthor)
    throw throwBadRequestError('The author of one of these images removed it from your showcase.');
  if (communityItems.length > VERSION_SHOWCASE_LIMIT)
    throw throwBadRequestError(
      `A showcase can feature at most ${VERSION_SHOWCASE_LIMIT} community images per site.`
    );
  if (communityItems.some((item) => item.excluded))
    throw throwBadRequestError(
      'Only your own images can be hidden; remove a community image instead.'
    );

  const eligible = await getEligibleCommunityImages(
    modelVersionId,
    site,
    communityItems.map((item) => item.imageId)
  );
  const { getGallerySettingsByModelId } = await import('~/server/services/model.service');
  const gallery = await getGallerySettingsByModelId({ id: version.model.id });
  const allowed = new Set(
    eligible
      .filter((image) => passesGalleryRules(gallery, { ...image, modelVersionId }))
      .map((image) => image.id)
  );
  const refused = communityItems.find((item) => !allowed.has(item.imageId));
  if (refused)
    throw throwBadRequestError(
      site === 'com'
        ? 'One of these images can’t be featured on civitai.com: it must be rated PG or PG-13, made with this version or posted to its gallery, and its author must allow it.'
        : 'One of these images can’t be featured: it must be made with this version or posted to its gallery, and its author must allow it.'
    );

  await dbWrite.$transaction([
    dbWrite.modelVersionShowcaseItem.deleteMany({
      where: { modelVersionId, site, removedByContributor: false },
    }),
    dbWrite.modelVersionShowcaseItem.createMany({
      data: unique.map((item) => ({
        modelVersionId,
        site,
        imageId: item.imageId,
        source: ownerIds.has(item.imageId) ? 'Owner' : 'Community',
        position: item.position ?? null,
        excluded: ownerIds.has(item.imageId) ? !!item.excluded : false,
        addedById: userId,
      })),
    }),
  ]);

  await refreshVersionShowcases([modelVersionId]);
  // A community cover no longer featured anywhere stops being the cover.
  await dropInvalidCommunityCovers([version.model.id]);

  const before = new Set(existing.map((row) => row.imageId));
  const added = eligible.filter((image) => allowed.has(image.id) && !before.has(image.id));
  await notifyFeaturedAuthors({ version, actorUserId: userId, images: added });
  return { modelVersionId, site };
}

/**
 * Sets a site's cover (slot 1 of the showcase): one of the creator's images on the model, or a
 * community image featured in the latest published version's showcase for that site. Null resets
 * it to the default. Runs the cover gate every cover write runs.
 */
export async function setVersionShowcaseCover({
  modelId,
  site,
  imageId,
  userId,
  isModerator,
}: {
  modelId: number;
  site: VersionShowcaseSite;
  imageId: number | null;
  userId: number;
  isModerator: boolean;
}) {
  const model = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: {
      userId: true,
      modelVersions: {
        where: { status: 'Published' },
        orderBy: { index: 'asc' },
        take: 1,
        select: { id: true },
      },
    },
  });
  if (!model) throw throwNotFoundError('Model not found');
  assertCanCurate(model, userId, isModerator);
  const latest = model.modelVersions[0]?.id;
  if (imageId && latest) {
    const isOwner = (await getOwnerImageIds(latest, [imageId])).has(imageId);
    if (!isOwner) {
      const row = await dbWrite.modelVersionShowcaseItem.findUnique({
        where: { modelVersionId_site_imageId: { modelVersionId: latest, site, imageId } },
        select: { source: true, removedByContributor: true },
      });
      if (!row || row.source !== 'Community' || row.removedByContributor)
        throw throwBadRequestError(
          'Feature this image in the latest version’s showcase before making it the cover.'
        );
    }
  }
  const { saveModelCovers } = await import('~/server/services/model-cover.service');
  await saveModelCovers({
    modelId,
    covers: { [coverColumnForSite(site)]: imageId },
    actorUserId: userId,
    isModerator,
  });
  if (latest) await refreshVersionShowcases([latest]);
}

/**
 * An image's author takes it out of a version's showcase, on both sites. The row stays as a
 * tombstone so the creator can't feature it again, and a cover it was stops being one. Works with
 * the feature flag off, so it is always available to the author.
 */
export async function removeMyImageFromVersionShowcase({
  modelVersionId,
  imageId,
  userId,
}: {
  modelVersionId: number;
  imageId: number;
  userId: number;
}) {
  const image = await dbWrite.image.findUnique({
    where: { id: imageId },
    select: { userId: true },
  });
  if (!image || image.userId !== userId)
    throw throwAuthorizationError('You can only remove your own images.');
  const { count } = await dbWrite.modelVersionShowcaseItem.updateMany({
    where: { modelVersionId, imageId, source: 'Community' },
    data: { removedByContributor: true, position: null },
  });
  if (!count) throw throwNotFoundError('This image isn’t featured in that showcase.');
  const version = await getVersionForWrite(modelVersionId);
  await refreshVersionShowcases([modelVersionId]);
  await dropInvalidCommunityCovers([version.model.id]);
}

/** A moderator takes an image out of a version's showcase (both sites); works with the flag off. */
export async function moderatorRemoveFromVersionShowcase({
  modelVersionId,
  imageId,
}: {
  modelVersionId: number;
  imageId: number;
}) {
  await dbWrite.modelVersionShowcaseItem.deleteMany({
    where: { modelVersionId, imageId, source: 'Community' },
  });
  const version = await getVersionForWrite(modelVersionId);
  await refreshVersionShowcases([modelVersionId]);
  await dropInvalidCommunityCovers([version.model.id]);
}

export const versionShowcaseFeaturedKey = (modelVersionId: number, imageId: number) =>
  `model-version-showcase-featured:${modelVersionId}:${imageId}`;

/** Tells each newly featured author, once per version and image, never on a self-add. */
async function notifyFeaturedAuthors({
  version,
  actorUserId,
  images,
}: {
  version: Awaited<ReturnType<typeof getVersionForWrite>>;
  actorUserId: number;
  images: { id: number; userId: number }[];
}) {
  if (!images.length) return;
  const [{ createNotification }, owner] = await Promise.all([
    import('~/server/services/notification.service'),
    dbWrite.user.findUnique({ where: { id: version.model.userId }, select: { username: true } }),
  ]);
  for (const image of images) {
    if (image.userId === actorUserId || image.userId === version.model.userId) continue;
    await createNotification({
      userId: image.userId,
      type: 'model-version-showcase-featured',
      category: NotificationCategory.Update,
      key: versionShowcaseFeaturedKey(version.id, image.id),
      details: {
        modelId: version.model.id,
        modelName: version.model.name,
        modelVersionId: version.id,
        imageId: image.id,
        username: owner?.username,
      },
    }).catch(() => null);
  }
}

// --- Reads for the editor and for authors ---------------------------------------------------------

/** What the showcase editor needs for one version: both sites' rows and the images to arrange. */
export async function getVersionShowcaseEditor({
  modelVersionId,
  userId,
  isModerator,
}: {
  modelVersionId: number;
  userId: number;
  isModerator: boolean;
}) {
  const version = await getVersionForWrite(modelVersionId);
  assertCanCurate(version.model, userId, isModerator);
  const [{ imagesForModelVersionsCache }, model, tombstones] = await Promise.all([
    import('~/server/services/image.service'),
    dbWrite.model.findUnique({
      where: { id: version.model.id },
      select: {
        coverImageId: true,
        sfwCoverImageId: true,
        modelVersions: {
          where: { status: 'Published' },
          orderBy: { index: 'asc' },
          take: 1,
          select: { id: true },
        },
      },
    }),
    dbWrite.modelVersionShowcaseItem.findMany({
      where: { modelVersionId, removedByContributor: true },
      select: { imageId: true, site: true },
    }),
  ]);
  await refreshVersionShowcases([modelVersionId]);
  const [owner, showcase] = await Promise.all([
    imagesForModelVersionsCache.fetch([modelVersionId]),
    getVersionShowcases([modelVersionId]),
  ]);
  return {
    modelId: version.model.id,
    modelVersionId,
    isMature: version.model.nsfw,
    isLatestPublished: model?.modelVersions[0]?.id === modelVersionId,
    covers: { com: model?.sfwCoverImageId ?? null, red: model?.coverImageId ?? null },
    ownerImages: owner[modelVersionId]?.images ?? [],
    rows: showcase[modelVersionId]?.rows ?? [],
    community: showcase[modelVersionId]?.community ?? [],
    removedByAuthors: tombstones,
    limit: VERSION_SHOWCASE_LIMIT,
  };
}

/** The live showcase rows featuring one of the viewer's images, for the author's remove action. */
export async function getMyImageShowcaseFeatures({
  imageId,
  userId,
}: {
  imageId: number;
  userId: number;
}) {
  return dbRead.$queryRaw<
    { modelVersionId: number; modelId: number; modelName: string; site: VersionShowcaseSite }[]
  >`
    SELECT s."modelVersionId", mv."modelId", m.name AS "modelName", s.site
    FROM "ModelVersionShowcaseItem" s
    JOIN "Image" i ON i.id = s."imageId"
    JOIN "ModelVersion" mv ON mv.id = s."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE s."imageId" = ${imageId}
      AND i."userId" = ${userId}
      AND s.source = 'Community'
      AND NOT s."removedByContributor"
  `;
}

/**
 * A version merge moves the source versions' showcase rows to the target, keeping the target's own
 * row (or the newest source's) when two name the same image and site, then refreshes the caches.
 * Runs after the merge commits and never fails it.
 */
export async function repointVersionShowcases(targetVersionId: number, sourceVersionIds: number[]) {
  if (!sourceVersionIds.length) return;
  try {
    await dbWrite.$transaction([
      dbWrite.$executeRaw`
        INSERT INTO "ModelVersionShowcaseItem"
          ("modelVersionId", site, "imageId", source, position, excluded,
           "removedByContributor", "addedById", "createdAt")
        SELECT DISTINCT ON (s.site, s."imageId")
          ${targetVersionId}, s.site, s."imageId", s.source, s.position, s.excluded,
          s."removedByContributor", s."addedById", s."createdAt"
        FROM "ModelVersionShowcaseItem" s
        WHERE s."modelVersionId" IN (${Prisma.join(sourceVersionIds)})
        ORDER BY s.site, s."imageId", s."modelVersionId" DESC
        ON CONFLICT ("modelVersionId", site, "imageId") DO NOTHING
      `,
      dbWrite.$executeRaw`
        DELETE FROM "ModelVersionShowcaseItem"
        WHERE "modelVersionId" IN (${Prisma.join(sourceVersionIds)})
      `,
    ]);
    await refreshVersionShowcases([targetVersionId, ...sourceVersionIds]);
  } catch (error) {
    logShowcaseError('version-showcase-merge-repoint-failed', error);
  }
}
