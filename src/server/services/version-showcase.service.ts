import { Prisma } from '@prisma/client';
import { CacheTTL, CAROUSEL_LIMIT } from '~/server/common/constants';
import { imageBlockedForConditions, imageReviewedSql } from '~/server/common/image-visibility';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLagBatch, preventReplicationLagBatch } from '~/server/db/db-lag-helpers';
import { logToAxiom } from '~/server/logging/client';
import { notBlockedBetween } from '~/server/notifications/base.notifications';
import { REDIS_KEYS } from '~/server/redis/client';
import type { ImagesForModelVersions } from '~/server/services/image.service';
import { getImageTagRows } from '~/server/redis/image-tag-rows';
import type { ModelGallerySettingsSchema } from '~/server/schema/model.schema';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { bustPublicModelResponseCache } from '~/server/services/public-model-response-cache';
import { createCachedObject } from '~/server/utils/cache-helpers';
import { imageOnSiteSql } from '~/server/utils/image-onsite';
import {
  allBrowsingLevelsFlag,
  heldGalleryLevel,
  nsfwBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  coverColumnForSite,
  type VersionShowcaseSite,
} from '~/shared/constants/version-showcase.constants';
import { Flags } from '~/shared/utils/flags';
import { isComSafeLevel } from '~/shared/utils/model-sfw-face';

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

export type CachedVersionShowcase = {
  modelVersionId: number;
  rows: VersionShowcaseRow[];
  /** Community rows that pass every filter today, as image rows ready to serve. */
  community: VersionShowcaseCommunityImage[];
};

/**
 * Must stay in step with the owner showcase's shared-cache filter (getImagesForModelVersion with no
 * viewer).
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
export function communityImageConditions(): Prisma.Sql[] {
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
      // An empty record, so a version with no rows is cached too.
      for (const id of ids) records[id] = { modelVersionId: id, rows: [], community: [] };

      const rows = await db.$queryRaw<(VersionShowcaseRow & { modelVersionId: number })[]>`
      SELECT s."modelVersionId", s."imageId", s.site, s.source, s.position, s.excluded
      FROM "ModelVersionShowcaseItem" s
      WHERE s."modelVersionId" IN (${Prisma.join(ids)})
        AND NOT s."removed"
    `;
      for (const row of rows) records[row.modelVersionId].rows.push(row);

      const withCommunity = [
        ...new Set(rows.filter((r) => r.source === 'Community').map((r) => r.modelVersionId)),
      ];
      if (!withCommunity.length) return records;

      const community = await db.$queryRaw<(VersionShowcaseCommunityImage & ModelGalleryRow)[]>`
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
        i."meta"->'extra'->'remixOfId' AS "remixOfId",
        m."gallerySettings", m.minor AS "modelMinor", m."sfwOnly" AS "modelSfwOnly"
      FROM "ModelVersionShowcaseItem" s
      JOIN "ModelVersion" mv ON mv.id = s."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      JOIN "Image" i ON i.id = s."imageId"
      JOIN "Post" p ON p.id = i."postId"
      JOIN "User" u ON u.id = i."userId"
      WHERE s."modelVersionId" IN (${Prisma.join(withCommunity)})
        AND s.source = 'Community'
        AND NOT s."removed"
        AND ${madeWithOrPostedTo()}
        AND ${Prisma.join([...showcaseImageConditions(), ...communityImageConditions()], ' AND ')}
    `;
      if (!community.length) return records;

      // Their tag ids, kept with them: the card feed and the public API drop an image with no tags
      // when the viewer excludes any.
      const tagRows = await getImageTagRows(db, [...new Set(community.map((image) => image.id))]);
      const tagsOf = new Map<number, number[]>();
      for (const row of tagRows)
        tagsOf.set(row.imageId, [...(tagsOf.get(row.imageId) ?? []), row.tagId]);

      for (const { gallerySettings, modelMinor, modelSfwOnly, ...image } of community) {
        const rules = galleryRulesOf({ gallerySettings, modelMinor, modelSfwOnly });
        if (passesGalleryRules(rules, image))
          records[image.modelVersionId].community.push({
            ...image,
            tags: tagsOf.get(image.id) ?? [],
          });
      }
      return records;
    },
  });

export type GallerySettings = {
  hiddenUsers?: { id: number }[];
  hiddenImages?: Record<string | number, number[]>;
  sfwHeld?: boolean;
  level?: number;
} | null;

export type ModelGalleryRow = {
  gallerySettings: Pick<ModelGallerySettingsSchema, 'users' | 'hiddenImages' | 'level'> | null;
  modelMinor: boolean;
  modelSfwOnly: boolean;
};

/**
 * The model's gallery rules as `getGallerySettingsByModelId` derives them, from the model row: read
 * here rather than through model.service, whose import cycle this module stays out of.
 */
export function galleryRulesOf({
  gallerySettings,
  modelMinor,
  modelSfwOnly,
}: ModelGalleryRow): GallerySettings {
  const sfwHeld = modelMinor || modelSfwOnly;
  if (!gallerySettings && !sfwHeld) return null;
  const stored = gallerySettings ?? {};
  return {
    hiddenUsers: (stored.users ?? []).map((id) => ({ id })),
    hiddenImages: stored.hiddenImages ?? {},
    sfwHeld,
    level: sfwHeld
      ? heldGalleryLevel(stored.level, { minor: modelMinor, sfwOnly: modelSfwOnly })
      : stored.level ?? allBrowsingLevelsFlag,
  };
}

/** The model's own gallery rules: hidden users and images, and the held level of a minor or
 *  SFW-only model. */
export function passesGalleryRules(
  gallery: GallerySettings | undefined,
  image: { id: number; userId: number; nsfwLevel: number; modelVersionId: number }
) {
  if (gallery?.hiddenUsers?.some((user) => user.id === image.userId)) return false;
  if (gallery?.hiddenImages?.[image.modelVersionId]?.includes(image.id)) return false;
  if (gallery?.sfwHeld && !Flags.intersects(gallery.level ?? 0, image.nsfwLevel)) return false;
  return true;
}

/**
 * Whether curated showcases are served (`modelVersionShowcaseServe`). Off, every reader serves the
 * creator's own images and cover, curating is refused, and the stored rows and covers are kept for
 * when it is back on. Removals still work.
 */
export function showcasesServed() {
  return getFeatureFlagsLazy({}).modelVersionShowcaseServe;
}

export async function getVersionShowcases(modelVersionIds: number[]) {
  if (!modelVersionIds.length || !showcasesServed())
    return {} as Record<number, CachedVersionShowcase>;
  return getVersionShowcaseCache().fetch(modelVersionIds);
}

/**
 * Whether any of these versions is curated on either site. A curated showcase's images are not
 * reflected in the version's level, so a response carrying one must not be shared-cached. A failed
 * read counts as curated: the response's own read may still have served the curated list.
 */
export async function hasCuratedShowcase(modelVersionIds: number[]) {
  if (!modelVersionIds.length) return false;
  try {
    const showcases = await getVersionShowcases(modelVersionIds);
    return modelVersionIds.some((id) => !!showcases[id]?.rows.length);
  } catch (error) {
    logShowcaseError('version-showcase-read-failed', error);
    return true;
  }
}

/**
 * The site whose curation a version serves on `site`: its own, or, when the creator curated only
 * the other site, that one (filtered to this site's levels by the caller). Null when uncurated.
 */
function curatedSiteFor(entry: CachedVersionShowcase | undefined, site: VersionShowcaseSite) {
  if (entry?.rows.some((row) => row.site === site)) return site;
  const other: VersionShowcaseSite = site === 'com' ? 'red' : 'com';
  return entry?.rows.some((row) => row.site === other) ? other : null;
}

/** The community images a version serves on `site`, from the curation it uses there. */
function communityFor(entry: CachedVersionShowcase, site: VersionShowcaseSite) {
  const curated = curatedSiteFor(entry, site);
  return entry.community.filter(
    (image) => image.site === curated && (site !== 'com' || isComSafeLevel(image.nsfwLevel))
  );
}

/**
 * Order: the model's cover for that site when it is in this list, then positioned items, then the
 * owner's remaining images in their usual order. Excluded owner images are left out. Capped at the
 * carousel's limit. Null when the version is curated on neither site.
 */
function orderVersionShowcase(
  entry: CachedVersionShowcase | undefined,
  site: VersionShowcaseSite,
  ownerImageIds: number[],
  coverImageId: number | null
): number[] | null {
  const curated = curatedSiteFor(entry, site);
  if (!entry || !curated) return null;
  const rows = entry.rows.filter((row) => row.site === curated);

  const excluded = new Set(rows.filter((row) => row.excluded).map((row) => row.imageId));
  const community = new Set(communityFor(entry, site).map((image) => image.id));
  // The owner cache holds only the first page; an owner image positioned beyond it comes from its
  // row (the carousel's hydrate re-checks every id against the viewer's filters).
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
  return [...new Set(ordered)].slice(0, CAROUSEL_LIMIT);
}

/**
 * The carousel's image ids for one version and site when the creator has curated it (on either
 * site), or null when they haven't (or the showcase can't be read), in which case the carousel
 * keeps today's list.
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
    return orderVersionShowcase(entry, site, ownerImageIds, coverImageId);
  } catch (error) {
    logShowcaseError('version-showcase-read-failed', error, { modelVersionId });
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
  ownerImageIds,
}: {
  modelVersionId: number;
  site: VersionShowcaseSite;
  /** The creator's cached images for the version (image.service's version cache). */
  ownerImageIds: () => Promise<number[]>;
}) {
  try {
    const entry = (await getVersionShowcases([modelVersionId]))[modelVersionId];
    if (!curatedSiteFor(entry, site)) return null;
    const [owner, version] = await Promise.all([
      ownerImageIds(),
      dbRead.modelVersion.findUnique({
        where: { id: modelVersionId },
        select: { model: { select: { coverImageId: true, sfwCoverImageId: true } } },
      }),
    ]);
    return getVersionShowcaseImageIds({
      modelVersionId,
      site,
      ownerImageIds: owner,
      coverImageId: version?.model[coverColumnForSite(site)] ?? null,
    });
  } catch (error) {
    logShowcaseError('version-showcase-read-failed', error, { modelVersionId });
    return null;
  }
}

/**
 * Images by version as the public API serves them: a curated showcase in place of the default list,
 * in its order, with the community images it features. Uncurated versions keep their list, and a
 * failed read keeps every list. Never mutates `byVersion`: its entries can be the shared cache's.
 */
export async function withCuratedShowcases<E extends { images: ImagesForModelVersions[] }>(
  byVersion: Record<number, E>,
  site: VersionShowcaseSite
): Promise<Record<number, E>> {
  const versionIds = Object.keys(byVersion).map(Number);
  if (!versionIds.length) return byVersion;
  try {
    const showcases = await getVersionShowcases(versionIds);
    // A deleted, held or moderated image can still sit in the cache.
    const communityIds = versionIds.flatMap((id) =>
      showcases[id] ? communityFor(showcases[id], site).map((image) => image.id) : []
    );
    const live = await liveCommunityLevels(communityIds);
    const served = new Map<number, ImagesForModelVersions>(
      versionIds.flatMap((id) =>
        showcases[id]
          ? communityFor(showcases[id], site).flatMap((image) => {
              const nsfwLevel = live.get(image.id);
              if (nsfwLevel === undefined) return [];
              if (site === 'com' && !isComSafeLevel(nsfwLevel)) return [];
              // Served in the creator's image shape: the showcase's own fields stay internal.
              const { site: _site, authorUsername: _authorUsername, ...row } = image;
              return [[image.id, { ...row, nsfwLevel }] as const];
            })
          : []
      )
    );
    const result: Record<number, E> = { ...byVersion };
    for (const versionId of versionIds) {
      const entry = showcases[versionId];
      const owner = byVersion[versionId].images;
      const ids = orderVersionShowcase(
        entry,
        site,
        owner.map((image) => image.id),
        null
      );
      if (!ids) continue;
      const byId = new Map<number, ImagesForModelVersions>(owner.map((image) => [image.id, image]));
      for (const image of communityFor(entry, site)) {
        const image_ = served.get(image.id);
        if (image_) byId.set(image.id, image_);
      }
      result[versionId] = {
        ...byVersion[versionId],
        images: ids.flatMap((id) => byId.get(id) ?? []),
      };
    }
    return result;
  } catch (error) {
    logShowcaseError('version-showcase-read-failed', error);
    return byVersion;
  }
}

export type ShowcaseCommunityCovers = Map<
  string,
  { image: VersionShowcaseCommunityImage; sites: Set<VersionShowcaseSite> }
>;
export const coverKey = (modelId: number, imageId: number) => `${modelId}:${imageId}`;

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
      AND NOT s."removed"
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
  // Validation read the showcases fresh from the primary; readers drawing the cover check each
  // image's live state and rating.
  if (!primary) {
    const live = await liveCommunityLevels([...found.values()].map((entry) => entry.image.id));
    for (const [key, entry] of found) {
      const nsfwLevel = live.get(entry.image.id);
      if (nsfwLevel !== undefined && !isComSafeLevel(nsfwLevel)) entry.sites.delete('com');
      if (nsfwLevel === undefined || !entry.sites.size) found.delete(key);
      else entry.image = { ...entry.image, nsfwLevel };
    }
  }
  return found;
}

/**
 * The live rating of each community image that still passes the showcase filters. A moderation
 * action can miss the showcase cache's refresh, so what is served is checked against the rows.
 */
async function liveCommunityLevels(imageIds: number[]) {
  const levels = new Map<number, number>();
  if (!imageIds.length) return levels;
  const rows = await dbRead.$queryRaw<{ id: number; nsfwLevel: number }[]>`
    SELECT i.id, i."nsfwLevel" FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    WHERE i.id IN (${Prisma.join([...new Set(imageIds)])})
      AND p.availability = 'Public'
      AND ${Prisma.join(showcaseImageConditions(), ' AND ')}
  `;
  for (const row of rows) levels.set(row.id, row.nsfwLevel);
  return levels;
}

export function logShowcaseError(name: string, error: unknown, fields?: Record<string, unknown>) {
  logToAxiom(
    { type: 'error', name, ...fields, message: (error as Error)?.message ?? String(error) },
    'civitai-prod'
  );
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
  // The replica: this runs on every post bust, and a featured image and its showcase row are old
  // by then; a deleted image is found by id (bustVersionShowcasesForImages).
  return dbRead.$queryRaw<{ modelVersionId: number; modelId: number }[]>`
    SELECT DISTINCT s."modelVersionId", mv."modelId"
    FROM "Image" i
    JOIN "ModelVersionShowcaseItem" s ON s."imageId" = i.id
    JOIN "ModelVersion" mv ON mv.id = s."modelVersionId"
    WHERE i."postId" IN (${Prisma.join(postIds)})
  `;
}

/**
 * After showcase rows change. A cover that stops qualifying is skipped by every reader at once, and
 * its column is cleared by the curation module (after a write, and by its sweep job).
 */
async function afterShowcaseChange(modelVersionIds: number[], modelIds: number[]) {
  await refreshVersionShowcases(modelVersionIds);
  await bustPublicModelResponseCache([...new Set(modelIds)]);
}

/**
 * After images are deleted: refreshes every showcase that featured them. Showcase rows have no
 * foreign key, so they are found by image id once the image row is gone.
 */
export async function bustVersionShowcasesForImages(imageIds: number[]) {
  const ids = [...new Set(imageIds)];
  if (!ids.length) return;
  try {
    const affected = await dbWrite.$queryRaw<{ modelVersionId: number; modelId: number }[]>`
      SELECT DISTINCT s."modelVersionId", mv."modelId"
      FROM "ModelVersionShowcaseItem" s
      JOIN "ModelVersion" mv ON mv.id = s."modelVersionId"
      WHERE s."imageId" IN (${Prisma.join(ids)}) AND s.source = 'Community'
    `;
    if (!affected.length) return;
    await refreshVersionShowcases(affected.map((row) => row.modelVersionId));
    const modelIds = [...new Set(affected.map((row) => row.modelId))];
    await bustPublicModelResponseCache(modelIds);
  } catch (error) {
    // Best effort: the delete already committed.
    logShowcaseError('version-showcase-bust-failed', error);
  }
}

/** Refreshes every showcase holding these posts' images. */
export async function bustVersionShowcasesForPosts(postIds: number[]) {
  try {
    const affected = await getShowcaseVersionsForPosts(postIds);
    if (!affected.length) return;
    await afterShowcaseChange(
      affected.map((row) => row.modelVersionId),
      affected.map((row) => row.modelId)
    );
  } catch (error) {
    // Best effort: the triggering write already committed.
    logShowcaseError('version-showcase-bust-failed', error);
  }
}

/**
 * Refreshes every showcase holding a user's images: after a ban, an opt-out, or a block or gallery
 * hide involving them. Starts from the showcase table, not from the user's images.
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
    await afterShowcaseChange(
      affected.map((row) => row.modelVersionId),
      affected.map((row) => row.modelId)
    );
  } catch (error) {
    // Best effort: the triggering write already committed.
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
    await afterShowcaseChange(
      affected.map((row) => row.modelVersionId),
      modelIds
    );
  } catch (error) {
    // Best effort: the triggering write already committed.
    logShowcaseError('version-showcase-bust-failed', error);
  }
}

/** A community image belongs to version `mv`: made with it, or posted to its gallery. */
export const madeWithOrPostedTo = () => Prisma.sql`(
  p."modelVersionId" = mv.id
  OR EXISTS (
    SELECT 1 FROM "ImageResourceNew" ir WHERE ir."imageId" = i.id AND ir."modelVersionId" = mv.id
  )
)`;

export const versionShowcaseFeaturedKey = (modelVersionId: number, imageId: number) =>
  `model-version-showcase-featured:${modelVersionId}:${imageId}`;

/**
 * The live showcase rows featuring an image, for the remove action: the author's own image, or any
 * image for a moderator.
 */
export async function getMyImageShowcaseFeatures({
  imageId,
  userId,
  isModerator,
}: {
  imageId: number;
  userId: number;
  isModerator: boolean;
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
      AND (${isModerator} OR i."userId" = ${userId})
      AND s.source = 'Community'
      AND NOT s."removed"
  `;
}

/**
 * A version merge moves the source versions' showcase rows to the target, then refreshes the
 * caches. When two rows name the same image and site, a removal wins; otherwise the target keeps its
 * own row, or the source row from the highest version id. Runs after the merge commits and never
 * fails it.
 */
export async function repointVersionShowcases(targetVersionId: number, sourceVersionIds: number[]) {
  if (!sourceVersionIds.length) return;
  try {
    await dbWrite.$transaction([
      dbWrite.$executeRaw`
        INSERT INTO "ModelVersionShowcaseItem"
          ("modelVersionId", site, "imageId", source, position, excluded,
           "removed", "addedById", "createdAt")
        SELECT DISTINCT ON (s.site, s."imageId")
          ${targetVersionId}, s.site, s."imageId", s.source, s.position, s.excluded,
          s."removed", s."addedById", s."createdAt"
        FROM "ModelVersionShowcaseItem" s
        WHERE s."modelVersionId" IN (${Prisma.join(sourceVersionIds)})
        -- A removal on any merged version holds on the target.
        ORDER BY s.site, s."imageId", s."removed" DESC, s."modelVersionId" DESC
        ON CONFLICT ("modelVersionId", site, "imageId") DO UPDATE SET removed = TRUE, position = NULL
          WHERE EXCLUDED."removed" AND "ModelVersionShowcaseItem".source = 'Community'
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
