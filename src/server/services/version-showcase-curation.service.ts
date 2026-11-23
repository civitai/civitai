import { Prisma } from '@prisma/client';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  imageBlockedForConditions,
  minorMatureImageVisibleSql,
} from '~/server/common/image-visibility';
import { bustPublicModelResponseCache } from '~/server/services/public-model-response-cache';
import {
  communityImageConditions,
  galleryRulesOf,
  getShowcaseCommunityCovers,
  getVersionShowcases,
  isShowcaseCoverImage,
  logShowcaseError,
  madeWithOrPostedTo,
  passesGalleryRules,
  refreshVersionShowcases,
  showcaseImageConditions,
  showcasesServed,
  versionShowcaseFeaturedKey,
  type ModelGalleryRow,
} from '~/server/services/version-showcase.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import {
  coverColumnForSite,
  VERSION_SHOWCASE_LIMIT,
  type VersionShowcaseSite,
} from '~/shared/constants/version-showcase.constants';
import { isComSafeLevel } from '~/shared/utils/model-sfw-face';

// The showcase's writes: curating, covers, removals and clearing covers that no longer qualify.
// Apart from version-showcase.service so the modules in image.service's import cycle, which import
// that one, never import the services these need.

async function assertShowcasesServed() {
  if (!(await showcasesServed()))
    throw throwBadRequestError('Model showcases are paused. Try again later.');
}

/**
 * Clears any model cover that is a community image no longer allowed there for a lasting reason:
 * removed, deleted, moved off the version, or its author banned, opted out, blocked or hidden from
 * the creator's galleries. An image only held by its own moderation state (waiting on review, a
 * rescan) keeps the cover: every reader checks that live, so the cover comes back when it clears.
 * The creator's own covers are left alone.
 */
export async function dropInvalidCommunityCovers(modelIds: number[]) {
  const ids = [...new Set(modelIds)];
  // Paused, no showcase reads as valid: the covers are kept, and readers skip them meanwhile.
  if (!ids.length || !(await showcasesServed())) return;
  const models = await dbWrite.$queryRaw<
    {
      id: number;
      userId: number;
      coverImageId: number | null;
      sfwCoverImageId: number | null;
      coverUserId: number | null;
      sfwCoverUserId: number | null;
      coverFeatured: boolean;
      sfwCoverFeatured: boolean;
    }[]
  >`
    SELECT m.id, m."userId", m."coverImageId", m."sfwCoverImageId",
      ci."userId" AS "coverUserId", si."userId" AS "sfwCoverUserId",
      ${featuredOnModel(Prisma.sql`m."coverImageId"`)} AS "coverFeatured",
      ${featuredOnModel(Prisma.sql`m."sfwCoverImageId"`)} AS "sfwCoverFeatured"
    FROM "Model" m
    LEFT JOIN "Image" ci ON ci.id = m."coverImageId"
    LEFT JOIN "Image" si ON si.id = m."sfwCoverImageId"
    WHERE m.id IN (${Prisma.join(ids)})
  `;
  const candidates = models.flatMap((model) =>
    (
      [
        ['red', model.coverImageId, model.coverUserId, model.coverFeatured],
        ['com', model.sfwCoverImageId, model.sfwCoverUserId, model.sfwCoverFeatured],
      ] as const
    )
      // Someone else's image, or a deleted one the model's showcase featured.
      .filter(
        ([, imageId, imageUserId, featured]) =>
          !!imageId && (imageUserId ? imageUserId !== model.userId : featured)
      )
      .map(([site, imageId]) => ({ modelId: model.id, site, imageId: imageId as number }))
  );
  if (!candidates.length) return;
  // Refreshes the versions holding the covers, which need not be the ones the caller refreshed.
  const valid = await getShowcaseCommunityCovers(candidates, { primary: true });
  const failing = candidates.filter((cover) => !isShowcaseCoverImage(valid, cover));
  const held = await heldOnlyByImageState(failing);
  const { saveModelCovers } = await import('~/server/services/model-cover.service');
  for (const { modelId, site, imageId } of failing) {
    if (held.has(`${modelId}:${imageId}:${site}`)) continue;
    await saveModelCovers({
      modelId,
      covers: { [coverColumnForSite(site)]: null },
      actorUserId: -1,
      systemReason: 'version-showcase-image-no-longer-eligible',
    });
  }
}

/**
 * The covers among these that fail only on a state the image passes through (waiting on a scan or
 * a review), as `model:image:site` keys. A blocked or ToS-removed image, a private post, and every
 * condition on its author stay lasting.
 */
async function heldOnlyByImageState(covers: { modelId: number; imageId: number; site: string }[]) {
  const held = new Set<string>();
  if (!covers.length) return held;
  // primary: judges a cover clear against the current state, like the validation beside it.
  const rows = await dbWrite.$queryRaw<
    ({
      modelId: number;
      modelVersionId: number;
      imageId: number;
      site: string;
      userId: number;
      nsfwLevel: number;
    } & ModelGalleryRow)[]
  >`
    SELECT DISTINCT mv."modelId", s."modelVersionId", s."imageId", s.site, i."userId", i."nsfwLevel",
      m."gallerySettings", m.minor AS "modelMinor", m."sfwOnly" AS "modelSfwOnly"
    FROM "ModelVersionShowcaseItem" s
    JOIN "ModelVersion" mv ON mv.id = s."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    JOIN "Image" i ON i.id = s."imageId"
    JOIN "Post" p ON p.id = i."postId"
    JOIN "User" u ON u.id = i."userId"
    WHERE s."imageId" IN (${Prisma.join(covers.map((cover) => cover.imageId))})
      AND mv."modelId" IN (${Prisma.join(covers.map((cover) => cover.modelId))})
      AND s.source = 'Community'
      AND NOT s."removed"
      AND ${madeWithOrPostedTo()}
      AND p."publishedAt" IS NOT NULL
      AND i."tosViolation" = FALSE
      AND ${Prisma.join(imageBlockedForConditions({}), ' AND ')}
      AND i."acceptableMinor" = FALSE
      AND i.ingestion NOT IN ('Blocked', 'NotFound')
      AND ${minorMatureImageVisibleSql({})}
      AND ((i."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0 OR NOT i."modelRestricted")
      AND ${Prisma.join(communityImageConditions(), ' AND ')}
  `;
  if (!rows.length) return held;
  // The model's own gallery rules are lasting too. An image not rated yet (level 0) is judged on
  // them without the held level, which it can't be checked against until it is rated.
  for (const row of rows) {
    const gallery = galleryRulesOf(row);
    const rules = row.nsfwLevel ? gallery : gallery && { ...gallery, sfwHeld: false };
    if (passesGalleryRules(rules, { ...row, id: row.imageId }))
      held.add(`${row.modelId}:${row.imageId}:${row.site}`);
  }
  return held;
}

/**
 * After a save or removal. A refresh that can't rebuild an entry marks it stale instead, so a read
 * rebuilds it; the rest is best effort, as the write already committed.
 */
async function afterShowcaseWrite(modelVersionId: number, modelId: number) {
  await refreshVersionShowcases([modelVersionId]);
  try {
    await bustPublicModelResponseCache([modelId]);
    await dropInvalidCommunityCovers([modelId]);
  } catch (error) {
    logShowcaseError('version-showcase-cover-drop-failed', error, { modelId });
  }
}

export type VersionShowcaseItemInput = {
  imageId: number;
  position?: number | null;
  excluded?: boolean;
};

async function getVersionForWrite(modelVersionId: number) {
  // primary: the ownership check guarding a showcase write.
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
      AND ${madeWithOrPostedTo()}
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
  await assertShowcasesServed();
  const version = await getVersionForWrite(modelVersionId);
  assertCanCurate(version.model, userId, isModerator);

  const unique = [...new Map(items.map((item) => [item.imageId, item])).values()];
  const ids = unique.map((item) => item.imageId);
  const [ownerIds, tombstones, existing] = await Promise.all([
    getOwnerImageIds(modelVersionId, ids),
    // A removal holds on both sites and on every version of the model, wherever it was made.
    // primary: the tombstone check guarding this write.
    dbWrite.$queryRaw<{ imageId: number }[]>`
      SELECT DISTINCT s."imageId"
      FROM "ModelVersionShowcaseItem" s
      JOIN "ModelVersion" mv ON mv.id = s."modelVersionId"
      WHERE mv."modelId" = ${version.model.id} AND s."removed"
    `,
    // primary: who is newly featured, to notify only them after the write.
    dbWrite.modelVersionShowcaseItem.findMany({
      where: { modelVersionId, removed: false, source: 'Community' },
      select: { imageId: true },
    }),
  ]);
  const removed = new Set(tombstones.map((row) => row.imageId));
  const communityItems = unique.filter((item) => !ownerIds.has(item.imageId));
  const blockedByAuthor = communityItems.find((item) => removed.has(item.imageId));
  if (blockedByAuthor)
    throw throwBadRequestError(
      'One of these images was removed from your showcase by its author or a moderator.'
    );
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
  // primary: the gallery rules guarding this write.
  const galleryRow = await dbWrite.$queryRaw<ModelGalleryRow[]>`
    SELECT "gallerySettings", minor AS "modelMinor", "sfwOnly" AS "modelSfwOnly"
    FROM "Model" WHERE id = ${version.model.id}
  `;
  const gallery = galleryRow[0] ? galleryRulesOf(galleryRow[0]) : null;
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
      where: { modelVersionId, site, removed: false },
    }),
    // Skips a row an author's or a moderator's removal wrote after the check above.
    dbWrite.modelVersionShowcaseItem.createMany({
      skipDuplicates: true,
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

  // Before the refresh: a retry finds these rows saved and would notify no one.
  const before = new Set(existing.map((row) => row.imageId));
  const added = eligible.filter((image) => allowed.has(image.id) && !before.has(image.id));
  await notifyFeaturedAuthors({ version, actorUserId: userId, images: added });

  // A community cover no longer featured anywhere stops being the cover.
  await afterShowcaseWrite(modelVersionId, version.model.id);
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
  await assertShowcasesServed();
  // primary: the ownership check guarding a cover write.
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
      // primary: the featured-row check guarding a cover write.
      const row = await dbWrite.modelVersionShowcaseItem.findUnique({
        where: { modelVersionId_site_imageId: { modelVersionId: latest, site, imageId } },
        select: { source: true, removed: true },
      });
      if (!row || row.source !== 'Community' || row.removed)
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
  // primary: the authorship check guarding a removal.
  const image = await dbWrite.image.findUnique({
    where: { id: imageId },
    select: { userId: true },
  });
  if (!image || image.userId !== userId)
    throw throwAuthorizationError('You can only remove your own images.');
  const count = await tombstoneOnEverySite(modelVersionId, imageId);
  if (!count) throw throwNotFoundError('This image isn’t featured in that showcase.');
  const version = await getVersionForWrite(modelVersionId);
  await afterShowcaseWrite(modelVersionId, version.model.id);
}

/**
 * A moderator takes an image out of a version's showcase, on both sites. Like an author's removal it
 * leaves a tombstone, so the creator can't feature it again. Works with the flag off.
 */
export async function moderatorRemoveFromVersionShowcase({
  modelVersionId,
  imageId,
  moderatorId,
}: {
  modelVersionId: number;
  imageId: number;
  moderatorId: number;
}) {
  const count = await tombstoneOnEverySite(modelVersionId, imageId);
  if (!count) throw throwNotFoundError('This image isn’t featured in that showcase.');
  const { trackModActivity } = await import('~/server/services/moderator.service');
  await trackModActivity(moderatorId, {
    entityType: 'image',
    entityId: imageId,
    activity: `versionShowcaseRemove:${modelVersionId}`,
  });
  const version = await getVersionForWrite(modelVersionId);
  await afterShowcaseWrite(modelVersionId, version.model.id);
}

/**
 * Marks a featured image removed on both sites, writing the row for a site it wasn't featured on.
 * A creator's save inserts without overwriting, so a removal that lands mid-save still holds.
 * Returns the rows written; 0 when the image isn't featured in the version.
 */
function tombstoneOnEverySite(modelVersionId: number, imageId: number) {
  return dbWrite.$executeRaw`
    INSERT INTO "ModelVersionShowcaseItem"
      ("modelVersionId", site, "imageId", source, position, excluded, removed, "addedById")
    SELECT s."modelVersionId", sites.site, s."imageId", 'Community', NULL, FALSE, TRUE, s."addedById"
    FROM (
      SELECT "modelVersionId", "imageId", "addedById" FROM "ModelVersionShowcaseItem"
      WHERE "modelVersionId" = ${modelVersionId} AND "imageId" = ${imageId} AND source = 'Community'
      LIMIT 1
    ) s
    CROSS JOIN (VALUES ('com'), ('red')) AS sites(site)
    ON CONFLICT ("modelVersionId", site, "imageId") DO UPDATE SET removed = TRUE, position = NULL
    WHERE "ModelVersionShowcaseItem".source = 'Community'
  `;
}

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
    dbRead.user.findUnique({ where: { id: version.model.userId }, select: { username: true } }),
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

/** What the showcase editor needs for one version: both sites' rows and the images to arrange. */
export async function getVersionShowcaseEditor({
  modelVersionId,
  userId,
  isModerator,
  safeOnly,
}: {
  modelVersionId: number;
  userId: number;
  isModerator: boolean;
  /** A viewer who can't view mature content (civitai.com) gets only PG and PG-13 images. */
  safeOnly: boolean;
}) {
  await assertShowcasesServed();
  const version = await getVersionForWrite(modelVersionId);
  assertCanCurate(version.model, userId, isModerator);
  const [{ imagesForModelVersionsCache }, model, tombstones] = await Promise.all([
    import('~/server/services/image.service'),
    // primary: the editor reloads right after a save and must show it.
    dbWrite.model.findUnique({
      where: { id: version.model.id },
      select: {
        nsfw: true,
        sfwName: true,
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
    // primary: the editor reloads right after a save and must show it.
    dbWrite.modelVersionShowcaseItem.findMany({
      where: { modelVersionId, removed: true },
      select: { imageId: true, site: true },
    }),
  ]);
  await refreshVersionShowcases([modelVersionId]);
  const [owner, showcase] = await Promise.all([
    imagesForModelVersionsCache.fetch([modelVersionId]),
    getVersionShowcases([modelVersionId]),
  ]);
  // primary: the editor reloads right after a save and must show it.
  const comCover = await dbWrite.image.findUnique({
    where: { id: model?.sfwCoverImageId ?? -1 },
    select: { userId: true },
  });
  const comCoverIsOwn = !!comCover && comCover.userId === version.model.userId;
  const shown = <I extends { nsfwLevel: number }>(images: I[]) =>
    safeOnly ? images.filter((image) => isComSafeLevel(image.nsfwLevel)) : images;
  return {
    modelId: version.model.id,
    modelVersionId,
    isLatestPublished: model?.modelVersions[0]?.id === modelVersionId,
    // A mature model is listed on civitai.com through its civitai.com title and its own cover there.
    listedOnComByOwnCover: !!model?.nsfw && model.sfwName != null && comCoverIsOwn,
    covers: { com: model?.sfwCoverImageId ?? null, red: model?.coverImageId ?? null },
    ownerImages: shown(owner[modelVersionId]?.images ?? []),
    rows: showcase[modelVersionId]?.rows ?? [],
    community: shown(showcase[modelVersionId]?.community ?? []),
    removedByAuthors: tombstones,
    limit: VERSION_SHOWCASE_LIMIT,
  };
}

/** Whether the image `column` names is featured by a community row on any of the model's versions. */
const featuredOnModel = (column: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "ModelVersionShowcaseItem" fs
  JOIN "ModelVersion" fmv ON fmv.id = fs."modelVersionId"
  WHERE fs."imageId" = ${column} AND fmv."modelId" = m.id AND fs.source = 'Community'
)`;

const SWEEP_BATCH = 100;

/**
 * Clears every cover column that names a featured image no longer allowed there. The busts that
 * follow a ban, opt-out, block, moderation action or delete only refresh: readers skip such a cover
 * at once, and this clears the column. Starts from the showcase table, so it reads only models that
 * featured someone's image as a cover.
 */
export async function sweepCommunityCovers() {
  const rows = await dbRead.$queryRaw<{ modelId: number }[]>`
    SELECT DISTINCT m.id AS "modelId"
    FROM "ModelVersionShowcaseItem" s
    JOIN "ModelVersion" mv ON mv.id = s."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE s.source = 'Community'
      AND (m."coverImageId" = s."imageId" OR m."sfwCoverImageId" = s."imageId")
  `;
  const modelIds = rows.map((row) => row.modelId);
  for (let i = 0; i < modelIds.length; i += SWEEP_BATCH) {
    const batch = modelIds.slice(i, i + SWEEP_BATCH);
    try {
      await dropInvalidCommunityCovers(batch);
    } catch (error) {
      logShowcaseError('version-showcase-cover-sweep-failed', error, { modelIds: batch });
    }
  }
  return { models: modelIds.length };
}
