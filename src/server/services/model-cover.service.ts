import type { Prisma } from '@prisma/client';
import { Tracker } from '~/server/clickhouse/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import type { ModelMeta } from '~/server/schema/model.schema';
import { modelsSearchIndex } from '~/server/search-index';
import type { ImagesForModelVersions } from '~/server/services/image.service';
import { getImagesForModelVersionCache } from '~/server/services/image.service';
import { getShowcaseCommunityCovers } from '~/server/services/version-showcase.service';
import { diffEntityChanges, resolveActorRole } from '~/server/utils/entity-change-helpers';
import {
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { ComCoverState } from '~/shared/utils/model-sfw-face';
import { comCoverState, isComSafeLevel } from '~/shared/utils/model-sfw-face';
import { isDefined } from '~/utils/type-guards';

/**
 * A picked cover must be the creator's own published image on this model, or a community image the
 * creator featured in this model's showcase for that site. The .com one must be rated PG or PG-13,
 * and on a mature model it must be the creator's own: the model is listed on .com through its own
 * .com cover, and someone else's image must not decide that. Throws on the first id that is not.
 */
export async function assertCoverImagesValid({
  modelId,
  ownerId,
  modelNsfw,
  coverImageId,
  sfwCoverImageId,
}: {
  modelId: number;
  ownerId: number;
  modelNsfw?: boolean;
  coverImageId?: number | null;
  sfwCoverImageId?: number | null;
}) {
  const ids = [coverImageId, sfwCoverImageId].filter(isDefined);
  if (!ids.length) return;

  const images = await dbRead.image.findMany({
    where: {
      id: { in: ids },
      post: { userId: ownerId, publishedAt: { not: null }, modelVersion: { modelId } },
    },
    select: { id: true, nsfwLevel: true },
  });
  const byId = new Map(images.map((image) => [image.id, image]));
  const notOwned = ids.filter((id) => !byId.has(id));
  const community = notOwned.length
    ? await getShowcaseCommunityCovers(
        notOwned.map((imageId) => ({ modelId, imageId })),
        { primary: true }
      )
    : new Map();

  if (coverImageId && !byId.has(coverImageId) && !community.get(coverImageId)?.sites.has('red'))
    throw throwBadRequestError(
      'The cover must be one of your published images on this model, or an image featured in its civitai.red showcase.'
    );
  if (sfwCoverImageId) {
    const owned = byId.get(sfwCoverImageId);
    const featured = community.get(sfwCoverImageId);
    if (!owned && featured && modelNsfw)
      throw throwBadRequestError(
        'On a mature model the civitai.com cover must be one of your own images.'
      );
    if (!owned && !featured?.sites.has('com'))
      throw throwBadRequestError(
        'The civitai.com cover must be one of your published images on this model, or an image featured in its civitai.com showcase.'
      );
    if (!isComSafeLevel(owned?.nsfwLevel ?? featured?.image.nsfwLevel ?? 0))
      throw throwBadRequestError('The civitai.com cover must be an image rated PG or PG-13.');
  }
}

/**
 * The chosen cover for each model, by model id. A cover counts only when it is the model owner's
 * image on one of the model's own versions; a cover already among the shown version's images comes
 * from there, and one on another version through the same cached, creator-only version-image read,
 * so it carries the same shape and filters. A dangling or foreign id is simply absent.
 */
export async function getCoverImages({
  covers,
  modelVersionImages,
  sameVersionOnly,
}: {
  covers: { modelId: number; ownerId: number; shownVersionId?: number; coverId: number | null }[];
  modelVersionImages: Record<number, { images: ImagesForModelVersions[] }>;
  sameVersionOnly: boolean;
}) {
  const found = new Map<number, ImagesForModelVersions>();
  const wanted = covers.filter(
    (cover): cover is typeof cover & { coverId: number } => cover.coverId != null
  );
  if (!wanted.length) return found;

  const pending: typeof wanted = [];
  for (const cover of wanted) {
    const shown = cover.shownVersionId ? modelVersionImages[cover.shownVersionId]?.images : [];
    const image = shown?.find((candidate) => candidate.id === cover.coverId);
    if (image) found.set(cover.modelId, image);
    else pending.push(cover);
  }
  if (!pending.length) return found;
  if (sameVersionOnly) return withCommunityCovers(found, pending, true);

  const rows = await dbRead.image.findMany({
    where: { id: { in: pending.map((cover) => cover.coverId) } },
    select: {
      id: true,
      post: {
        select: { userId: true, modelVersionId: true, modelVersion: { select: { modelId: true } } },
      },
    },
  });
  const located = pending.flatMap((cover) => {
    const row = rows.find((candidate) => candidate.id === cover.coverId);
    const versionId = row?.post?.modelVersionId;
    const owned =
      row?.post?.modelVersion?.modelId === cover.modelId && row.post.userId === cover.ownerId;
    return owned && versionId ? [{ ...cover, versionId }] : [];
  });
  if (!located.length) return withCommunityCovers(found, pending, false);

  const byVersion = await getImagesForModelVersionCache([
    ...new Set(located.map((cover) => cover.versionId)),
  ]);
  for (const cover of located) {
    const image = byVersion[cover.versionId]?.images.find(
      (candidate) => candidate.id === cover.coverId
    );
    if (image) found.set(cover.modelId, image);
  }
  return withCommunityCovers(found, pending, false);
}

/**
 * Fills in covers that are community images featured in the model's showcase (with the author's
 * username for credit). Under `sameVersionOnly`, only a community image on the shown version counts.
 */
async function withCommunityCovers(
  found: Map<number, ImagesForModelVersions>,
  pending: { modelId: number; shownVersionId?: number; coverId: number }[],
  sameVersionOnly: boolean
) {
  const missing = pending.filter((cover) => !found.has(cover.modelId));
  if (!missing.length) return found;
  const community = await getShowcaseCommunityCovers(
    missing.map((cover) => ({ modelId: cover.modelId, imageId: cover.coverId }))
  );
  for (const cover of missing) {
    const featured = community.get(cover.coverId);
    if (!featured) continue;
    if (sameVersionOnly && featured.image.modelVersionId !== cover.shownVersionId) continue;
    found.set(cover.modelId, featured.image);
  }
  return found;
}

/** The creator's own published images on every version of the model, for the cover pickers. */
export async function getCoverCandidates({ modelId }: { modelId: number }) {
  const versions = await dbRead.modelVersion.findMany({
    where: { modelId },
    select: { id: true },
    orderBy: { index: 'asc' },
  });
  if (!versions.length) return [];
  const byVersion = await getImagesForModelVersionCache(versions.map((version) => version.id));
  return versions.flatMap((version) =>
    (byVersion[version.id]?.images ?? []).map(({ id, url, type, metadata, nsfwLevel }) => ({
      id,
      url,
      type,
      metadata,
      nsfwLevel,
      modelVersionId: version.id,
    }))
  );
}

/**
 * Why a mature model's saved .com cover does not list it on .com, for its owner; null when it does
 * or when there is no .com cover to judge. Mirrors the cover conditions in `updateModelNsfwLevels`.
 */
export async function getComCoverState(model: {
  id: number;
  userId: number;
  nsfw: boolean;
  sfwName: string | null;
  sfwCoverImageId: number | null;
}): Promise<ComCoverState | null> {
  if (!model.nsfw || !model.sfwName || !model.sfwCoverImageId) return null;
  const image = await dbRead.image.findUnique({
    where: { id: model.sfwCoverImageId },
    select: {
      nsfwLevel: true,
      needsReview: true,
      tosViolation: true,
      acceptableMinor: true,
      blockedFor: true,
      ingestion: true,
      post: {
        select: {
          userId: true,
          publishedAt: true,
          modelVersion: { select: { modelId: true, status: true } },
        },
      },
    },
  });
  return comCoverState(
    image && {
      ...image,
      ownPost: image.post?.userId === model.userId,
      postPublished: image.post?.publishedAt != null,
      sameModel: image.post?.modelVersion?.modelId === model.id,
      versionPublished: image.post?.modelVersion?.status === 'Published',
    }
  );
}

type CoverColumns = { coverImageId: number | null; sfwCoverImageId: number | null };

/**
 * The checks every cover change runs before it is stored: the .com face text when the model has a
 * face and its .com cover is being set, then the covers themselves. Shared by the model editor
 * (`upsertModel`) and the showcase.
 */
export async function assertCoverChange({
  model,
  next,
  actorUserId,
  isModerator,
}: {
  model: CoverColumns & {
    id: number;
    userId: number;
    nsfw: boolean;
    name: string;
    description: string | null;
    sfwName: string | null;
    sfwDescription: string | null;
  };
  next: Partial<CoverColumns>;
  actorUserId: number;
  isModerator: boolean;
}) {
  const coverImageId =
    next.coverImageId !== undefined && next.coverImageId !== model.coverImageId
      ? next.coverImageId
      : undefined;
  const sfwCoverImageId =
    next.sfwCoverImageId !== undefined && next.sfwCoverImageId !== model.sfwCoverImageId
      ? next.sfwCoverImageId
      : undefined;
  if (!isModerator && model.sfwName && sfwCoverImageId) {
    const { assertSfwFaceSafe } = await import('~/server/services/model-sfw-face.service');
    await assertSfwFaceSafe({
      sfwName: model.sfwName,
      sfwDescription: model.sfwDescription,
      name: model.name,
      description: model.description,
      modelId: model.id,
      userId: actorUserId,
    });
  }
  await assertCoverImagesValid({
    modelId: model.id,
    ownerId: model.userId,
    modelNsfw: model.nsfw,
    coverImageId,
    sfwCoverImageId,
  });
}

/**
 * Stores a model's covers outside the model editor: the showcase's "make first", a contributor
 * removing their featured image, and the busts that drop an image that no longer qualifies. Runs
 * the same checks and follow-ups as an editor save, and refuses (409) when the stored covers changed
 * since they were read, as the listing re-check can clear the .com one at any time. A null clears.
 */
export async function saveModelCovers({
  modelId,
  covers,
  actorUserId,
  isModerator = false,
  systemReason,
  tracker,
}: {
  modelId: number;
  covers: Partial<CoverColumns>;
  actorUserId: number;
  isModerator?: boolean;
  /** A system clear of an image that no longer qualifies: no checks (nothing new is set), and the
   *  change is recorded as the system's, with this reason. */
  systemReason?: string;
  tracker?: Tracker;
}) {
  const model = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: {
      id: true,
      userId: true,
      nsfw: true,
      name: true,
      description: true,
      sfwName: true,
      sfwDescription: true,
      coverImageId: true,
      sfwCoverImageId: true,
      meta: true,
    },
  });
  if (!model) throw throwNotFoundError('Model not found');

  const after: CoverColumns = {
    coverImageId: covers.coverImageId !== undefined ? covers.coverImageId : model.coverImageId,
    sfwCoverImageId:
      covers.sfwCoverImageId !== undefined ? covers.sfwCoverImageId : model.sfwCoverImageId,
  };
  const before: CoverColumns = {
    coverImageId: model.coverImageId,
    sfwCoverImageId: model.sfwCoverImageId,
  };
  if (
    after.coverImageId === before.coverImageId &&
    after.sfwCoverImageId === before.sfwCoverImageId
  )
    return false;

  if (!systemReason) await assertCoverChange({ model, next: covers, actorUserId, isModerator });

  // A .com cover this write sets ends the listing re-check's removal, as an editor save does.
  let meta = (model.meta ?? {}) as ModelMeta;
  if (after.sfwCoverImageId && after.sfwCoverImageId !== before.sfwCoverImageId) {
    const { comFaceRemoved: _removed, ...rest } = meta;
    meta = rest;
  }
  const { count } = await dbWrite.model.updateMany({
    where: { id: modelId, ...before },
    data: { ...after, meta: meta as Prisma.InputJsonValue },
  });
  if (!count)
    throw throwConflictError('This model’s cover changed in the meantime. Reload and try again.');

  await afterCoverChange({
    modelId,
    ownerId: model.userId,
    actorUserId,
    isModerator,
    keepsFace: !!model.sfwName,
    before,
    after,
    systemReason,
    tracker,
  });
  return true;
}

/** What follows a stored cover change, wherever it was made. */
async function afterCoverChange({
  modelId,
  ownerId,
  actorUserId,
  isModerator,
  keepsFace,
  before,
  after,
  systemReason,
  tracker,
}: {
  modelId: number;
  ownerId: number;
  actorUserId: number;
  isModerator: boolean;
  keepsFace: boolean;
  before: CoverColumns;
  after: CoverColumns;
  systemReason?: string;
  tracker?: Tracker;
}) {
  const [{ queueComFaceRecheck }, { updateModelNsfwLevels }, { bustPublicModelResponseCache }] =
    await Promise.all([
      import('~/server/services/model-com-face-recheck.service'),
      import('~/server/services/nsfwLevels.service'),
      import('~/server/services/model-version.service'),
    ]);
  if (!isModerator && !systemReason && keepsFace) await queueComFaceRecheck(modelId);
  // The .com cover feeds a mature model's level, which decides whether .com lists it.
  await updateModelNsfwLevels([modelId]);
  await bustPublicModelResponseCache(modelId);
  await modelsSearchIndex.queueUpdate([
    { id: modelId, action: SearchIndexUpdateQueueAction.Update },
  ]);
  // The record a rollback restores covers from.
  const rows = diffEntityChanges({
    entityType: 'Model',
    entityId: modelId,
    ownerId,
    before,
    after,
    actorRole: resolveActorRole({ actorUserId, ownerId, isModerator }),
    systemFields: systemReason
      ? { coverImageId: systemReason, sfwCoverImageId: systemReason }
      : undefined,
  });
  await (tracker ?? new Tracker()).entityChanges(rows).catch(() => null);
}
