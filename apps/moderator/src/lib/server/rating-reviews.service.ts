import type { Transaction } from 'kysely';
import { sql } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  allBrowsingLevelsFlag,
  getHighestBrowsingLevelBit,
  NsfwLevel,
  nsfwBrowsingLevelsFlag,
} from '@civitai/shared';
import { hasCrucibleStarted } from '@civitai/shared/crucible';
import { challengeDerivedNsfwLevel, isTextScanRaised } from '@civitai/shared/rated-entity-sql';
import {
  collectionRatingLevel,
  isRatingReviewEntityType,
  ratingReviewEntityPath,
  ratingReviewModeratorLevels,
  textScanNsfwReason,
  textScanResultTextHash,
  type RatingReviewEntityType,
} from '@civitai/shared/rating-review';
import { dbRead, dbWrite } from './db';
import { challengeAllowedMaskAt } from './rating-review-apply';
import { computeRatedEntityDerivedNsfwLevel } from './rated-entity-derivation';
import { ReportStatus, type RatingReviewStatusFilter } from '$lib/rating-review';
import type { MediaType } from '$lib/media/edge-url';

export type RatingReviewUser = { id: number; username: string | null; image: string | null };

export type RatingReviewEntitySummary = {
  id: number;
  title: string;
  path: string | null;
  nsfwLevel: number;
  override: number | null;
  coverUrl: string | null;
  coverType: MediaType | null;
};

export type RatingReviewRow = {
  id: number;
  entityType: RatingReviewEntityType;
  entityId: number;
  createdAt: Date | null;
  resolvedAt: Date | null;
  status: ReportStatus;
  currentLevel: number;
  suggestedLevel: number;
  appliedLevel: number | null;
  userComment: string | null;
  modComment: string | null;
  user: RatingReviewUser;
  resolver: RatingReviewUser | null;
  entity: RatingReviewEntitySummary | null;
  scan: { level: number | null; reason: string | null } | null;
  levelOptions: number[];
};

// Blocked is a ToS action, not a rating, as in the main app's `ratedLevel`.
const ratingBits = (mask: number) => mask & allBrowsingLevelsFlag;

// A challenge or crucible is judged against its live level, not the review's snapshot: the mask can
// have moved since the dispute was filed.
function moderatorLevelsFor(
  entityType: RatingReviewEntityType,
  snapshotLevel: number,
  liveLevel: number | undefined
): number[] {
  const live = entityType === 'Challenge' || entityType === 'Crucible' ? liveLevel : undefined;
  const level = live != null ? getHighestBrowsingLevelBit(ratingBits(live)) : snapshotLevel;
  return ratingReviewModeratorLevels(entityType, level);
}

type Summary = Omit<RatingReviewEntitySummary, 'path'> & { parentId: number | null };

export type RatingReviewImage = {
  id: number;
  url: string;
  type: MediaType;
  nsfwLevel: number;
};

const IMAGE_FIELDS = ['i.id', 'i.url', 'i.type', 'i.nsfwLevel'] as const;

async function imagesById(ids: (number | null)[]): Promise<Map<number, RatingReviewImage>> {
  const wanted = [...new Set(ids.filter((id): id is number => id != null))];
  if (!wanted.length) return new Map();
  const found = await dbRead
    .selectFrom('Image as i')
    .select(IMAGE_FIELDS)
    .where('i.id', 'in', wanted)
    .execute();
  return new Map(found.map((r) => [r.id, r]));
}

// A post's images in the author's order; `index` ties are broken by id so the first image is stable.
async function postCovers(ids: number[]): Promise<Map<number, RatingReviewImage>> {
  if (!ids.length) return new Map();
  const found = await dbRead
    .selectFrom('Image as i')
    .distinctOn('i.postId')
    .select(['i.postId', ...IMAGE_FIELDS])
    .where('i.postId', 'in', ids)
    .orderBy('i.postId')
    .orderBy(sql`i."index" asc nulls last`)
    .orderBy('i.id')
    .execute();
  return new Map(found.map((r) => [r.postId!, r]));
}

async function connectionCovers(
  entityType: 'Bounty' | 'BountyEntry',
  ids: number[]
): Promise<Map<number, RatingReviewImage>> {
  if (!ids.length) return new Map();
  const found = await dbRead
    .selectFrom('ImageConnection as ic')
    .innerJoin('Image as i', 'i.id', 'ic.imageId')
    .distinctOn('ic.entityId')
    .select(['ic.entityId', ...IMAGE_FIELDS])
    .where('ic.entityType', '=', entityType)
    .where('ic.entityId', 'in', ids)
    .orderBy('ic.entityId')
    .orderBy('i.id')
    .execute();
  return new Map(found.map((r) => [r.entityId, r]));
}

// Mirrors the cover the main app picks for a model (image.service getImagesForModelsCover): the
// first published version that has a visible image. A version with none falls through to the next
// rather than leaving the model blank.
const modelGalleryJoins = sql`
  FROM "Model" m
  JOIN "ModelVersion" mv ON mv."modelId" = m."id" AND mv."status" = 'Published'
  JOIN "Post" p ON p."modelVersionId" = mv."id"
    AND (p."userId" = m."userId" OR m."userId" = -1)
    AND p."publishedAt" IS NOT NULL
  JOIN "Image" i ON i."postId" = p."id" AND i."needsReview" IS NULL AND i."acceptableMinor" = FALSE`;

async function modelCovers(
  ids: number[]
): Promise<Map<number, RatingReviewImage & { versionId: number }>> {
  if (!ids.length) return new Map();
  const { rows } = await sql<RatingReviewImage & { modelId: number; versionId: number }>`
    SELECT DISTINCT ON (m."id") m."id" AS "modelId", mv."id" AS "versionId",
      i."id", i."url", i."type", i."nsfwLevel"
    ${modelGalleryJoins}
    WHERE m."id" IN (${sql.join(ids)})
    ORDER BY m."id", mv."index", p."id", i."index", i."id"`.execute(dbRead);
  return new Map(rows.map((r) => [r.modelId, r]));
}

const asCover = (img: RatingReviewImage | undefined) => ({
  coverUrl: img?.url ?? null,
  coverType: img?.type ?? null,
});

async function loadSummaries(
  entityType: RatingReviewEntityType,
  ids: number[]
): Promise<Map<number, Summary>> {
  const out = new Map<number, Summary>();
  if (!ids.length) return out;
  const put = (s: Summary) => out.set(s.id, s);
  const base = { coverUrl: null, coverType: null, parentId: null };

  switch (entityType) {
    case 'Article': {
      const found = await dbRead
        .selectFrom('Article as a')
        .leftJoin('Image as i', 'i.id', 'a.coverId')
        .select([
          'a.id',
          'a.title',
          'a.nsfwLevel',
          'a.moderatorNsfwLevel',
          'a.cover',
          'i.url',
          'i.type',
        ])
        .where('a.id', 'in', ids)
        .execute();
      for (const r of found)
        put({
          id: r.id,
          title: r.title,
          nsfwLevel: r.nsfwLevel,
          override: r.moderatorNsfwLevel,
          coverUrl: r.url ?? r.cover,
          coverType: (r.type as MediaType | null) ?? null,
          parentId: null,
        });
      break;
    }
    case 'Model': {
      const found = await dbRead
        .selectFrom('Model')
        .select(['id', 'name', 'nsfwLevel'])
        .where('id', 'in', ids)
        .where('deletedAt', 'is', null)
        .execute();
      const covers = await modelCovers(found.map((r) => r.id));
      for (const r of found)
        put({
          ...base,
          ...asCover(covers.get(r.id)),
          id: r.id,
          title: r.name,
          nsfwLevel: r.nsfwLevel,
          override: null,
        });
      break;
    }
    case 'Post': {
      const found = await dbRead
        .selectFrom('Post')
        .select(['id', 'title', 'nsfwLevel', 'moderatorNsfwLevel'])
        .where('id', 'in', ids)
        .execute();
      const covers = await postCovers(found.map((r) => r.id));
      for (const r of found)
        put({
          ...base,
          ...asCover(covers.get(r.id)),
          id: r.id,
          title: r.title ?? `Post #${r.id}`,
          nsfwLevel: r.nsfwLevel,
          override: r.moderatorNsfwLevel,
        });
      break;
    }
    case 'Bounty': {
      const found = await dbRead
        .selectFrom('Bounty')
        .select(['id', 'name', 'nsfwLevel', 'moderatorNsfwLevel'])
        .where('id', 'in', ids)
        .execute();
      const covers = await connectionCovers(
        'Bounty',
        found.map((r) => r.id)
      );
      for (const r of found)
        put({
          ...base,
          ...asCover(covers.get(r.id)),
          id: r.id,
          title: r.name,
          nsfwLevel: r.nsfwLevel,
          override: r.moderatorNsfwLevel,
        });
      break;
    }
    case 'BountyEntry': {
      const found = await dbRead
        .selectFrom('BountyEntry')
        .select(['id', 'bountyId', 'nsfwLevel', 'moderatorNsfwLevel'])
        .where('id', 'in', ids)
        .execute();
      const covers = await connectionCovers(
        'BountyEntry',
        found.map((r) => r.id)
      );
      for (const r of found)
        put({
          ...base,
          ...asCover(covers.get(r.id)),
          id: r.id,
          title: `Entry #${r.id}`,
          nsfwLevel: r.nsfwLevel,
          override: r.moderatorNsfwLevel,
          parentId: r.bountyId,
        });
      break;
    }
    case 'Challenge': {
      const found = await dbRead
        .selectFrom('Challenge')
        .select(['id', 'title', 'nsfwLevel', 'moderatorNsfwLevel', 'coverImageId'])
        .where('id', 'in', ids)
        .execute();
      const covers = await imagesById(found.map((r) => r.coverImageId));
      for (const r of found)
        put({
          ...base,
          ...asCover(covers.get(r.coverImageId ?? 0)),
          id: r.id,
          title: r.title,
          nsfwLevel: r.nsfwLevel,
          override: r.moderatorNsfwLevel,
        });
      break;
    }
    case 'Crucible': {
      const found = await dbRead
        .selectFrom('Crucible')
        .select(['id', 'name', 'nsfwLevel', 'moderatorNsfwLevel', 'imageId', 'heroImageId'])
        .where('id', 'in', ids)
        .execute();
      const covers = await imagesById(found.map((r) => r.imageId ?? r.heroImageId));
      for (const r of found)
        put({
          ...base,
          ...asCover(covers.get(r.imageId ?? r.heroImageId ?? 0)),
          id: r.id,
          title: r.name,
          nsfwLevel: r.nsfwLevel,
          override: r.moderatorNsfwLevel,
        });
      break;
    }
    case 'Collection': {
      const found = await dbRead
        .selectFrom('Collection')
        .select(['id', 'name', 'nsfwLevel', 'moderatorNsfwLevel', 'imageId'])
        .where('id', 'in', ids)
        .execute();
      const covers = await imagesById(found.map((r) => r.imageId));
      for (const r of found)
        put({
          ...base,
          ...asCover(covers.get(r.imageId ?? 0)),
          id: r.id,
          title: r.name,
          nsfwLevel: collectionRatingLevel(r.nsfwLevel),
          override: r.moderatorNsfwLevel,
        });
      break;
    }
  }
  return out;
}

/** The images a moderator rates an entity from; `total` is the full count, `images` at most `limit`. */
export async function getRatingReviewImages(
  entityType: RatingReviewEntityType,
  entityId: number,
  limit = 6
): Promise<{ total: number; images: RatingReviewImage[] }> {
  const empty = { total: 0, images: [] };
  const single = async (imageId: number | null | undefined) => {
    const img = (await imagesById([imageId ?? null])).get(imageId ?? 0);
    return img ? { total: 1, images: [img] } : empty;
  };

  switch (entityType) {
    case 'Post': {
      const where = dbRead.selectFrom('Image as i').where('i.postId', '=', entityId);
      const [images, count] = await Promise.all([
        where
          .select(IMAGE_FIELDS)
          .orderBy(sql`i."index" asc nulls last`)
          .orderBy('i.id')
          .limit(limit)
          .execute(),
        where.select((eb) => eb.fn.countAll<string>().as('c')).executeTakeFirst(),
      ]);
      return { total: Number(count?.c ?? 0), images };
    }
    case 'Model': {
      const cover = (await modelCovers([entityId])).get(entityId);
      if (!cover) return empty;
      const [{ rows }, count] = await Promise.all([
        sql<RatingReviewImage>`
          SELECT i."id", i."url", i."type", i."nsfwLevel" ${modelGalleryJoins}
          WHERE m."id" = ${entityId} AND mv."id" = ${cover.versionId}
          ORDER BY p."id", i."index", i."id" LIMIT ${limit}`.execute(dbRead),
        sql<{ c: string }>`
          SELECT count(*) AS c ${modelGalleryJoins}
          WHERE m."id" = ${entityId} AND mv."id" = ${cover.versionId}`.execute(dbRead),
      ]);
      return { total: Number(count.rows[0]?.c ?? 0), images: rows };
    }
    case 'Article': {
      const article = await dbRead
        .selectFrom('Article')
        .select('coverId')
        .where('id', '=', entityId)
        .executeTakeFirst();
      return connected('Article', entityId, limit, article?.coverId ?? null);
    }
    case 'Bounty':
    case 'BountyEntry':
      return connected(entityType, entityId, limit, null);
    case 'Challenge': {
      const row = await dbRead
        .selectFrom('Challenge')
        .select('coverImageId')
        .where('id', '=', entityId)
        .executeTakeFirst();
      return single(row?.coverImageId);
    }
    case 'Crucible': {
      const row = await dbRead
        .selectFrom('Crucible')
        .select(['imageId', 'heroImageId'])
        .where('id', '=', entityId)
        .executeTakeFirst();
      return single(row?.imageId ?? row?.heroImageId);
    }
    case 'Collection': {
      const row = await dbRead
        .selectFrom('Collection')
        .select('imageId')
        .where('id', '=', entityId)
        .executeTakeFirst();
      return single(row?.imageId);
    }
  }
}

// Connection ids first, then images by id: the same shape as bulk-image's getImagesForConnection,
// minus its appeal lookups, which a thumbnail strip has no use for.
async function connected(
  entityType: 'Article' | 'Bounty' | 'BountyEntry',
  entityId: number,
  limit: number,
  coverId: number | null
) {
  const links = await dbRead
    .selectFrom('ImageConnection')
    .select('imageId')
    .where('entityType', '=', entityType)
    .where('entityId', '=', entityId)
    .orderBy('imageId')
    .limit(5000)
    .execute();
  const ids = [...new Set([...(coverId ? [coverId] : []), ...links.map((l) => l.imageId)])];
  const byId = await imagesById(ids.slice(0, limit));
  return {
    total: ids.length,
    images: ids.slice(0, limit).flatMap((id) => byId.get(id) ?? []),
  };
}

async function loadScans(entityType: RatingReviewEntityType, ids: number[]) {
  const out = new Map<number, { level: number | null; reason: string | null }>();
  if (!ids.length) return out;
  const found = await dbRead
    .selectFrom('EntityModeration')
    .select(['entityId', 'nsfwLevel', 'result'])
    .where('entityType', '=', entityType)
    .where('entityId', 'in', ids)
    .execute();
  for (const r of found)
    if (isTextScanRaised({ entityType, nsfwLevel: r.nsfwLevel, result: r.result }))
      out.set(r.entityId, { level: r.nsfwLevel, reason: textScanNsfwReason(r.result) });
  return out;
}

export async function getRatingReviews({
  status,
  entityType,
  page = 1,
  limit = 20,
}: {
  status: RatingReviewStatusFilter;
  entityType?: RatingReviewEntityType;
  page?: number;
  limit?: number;
}): Promise<{ items: RatingReviewRow[]; page: number; limit: number }> {
  let q = dbRead
    .selectFrom('RatingReview as rr')
    .innerJoin('User as owner', 'owner.id', 'rr.userId')
    .leftJoin('User as resolver', 'resolver.id', 'rr.resolvedBy')
    .where('rr.status', '=', status)
    .select([
      'rr.id',
      'rr.entityType',
      'rr.entityId',
      'rr.createdAt',
      'rr.resolvedAt',
      'rr.status',
      'rr.currentLevel',
      'rr.suggestedLevel',
      'rr.appliedLevel',
      'rr.userComment',
      'rr.modComment',
      'owner.id as ownerId',
      'owner.username as ownerUsername',
      'owner.image as ownerImage',
      'resolver.id as resolverId',
      'resolver.username as resolverUsername',
      'resolver.image as resolverImage',
    ])
    .orderBy('rr.id', 'desc')
    .limit(limit)
    .offset((page - 1) * limit);
  if (entityType) q = q.where('rr.entityType', '=', entityType);
  const found = (await q.execute()).filter((r) => isRatingReviewEntityType(r.entityType));

  const idsByType = new Map<RatingReviewEntityType, number[]>();
  for (const r of found) {
    const t = r.entityType as RatingReviewEntityType;
    idsByType.set(t, [...(idsByType.get(t) ?? []), r.entityId]);
  }
  const loaded = await Promise.all(
    [...idsByType].map(
      async ([t, ids]) => [t, await loadSummaries(t, ids), await loadScans(t, ids)] as const
    )
  );
  const summaries = new Map(loaded.map(([t, s]) => [t, s]));
  const scans = new Map(loaded.map(([t, , s]) => [t, s]));

  const items = found.map((r): RatingReviewRow => {
    const t = r.entityType as RatingReviewEntityType;
    const s = summaries.get(t)?.get(r.entityId);
    return {
      id: r.id,
      entityType: t,
      entityId: r.entityId,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      status: r.status,
      currentLevel: r.currentLevel,
      suggestedLevel: r.suggestedLevel,
      appliedLevel: r.appliedLevel,
      userComment: r.userComment,
      modComment: r.modComment,
      user: { id: r.ownerId, username: r.ownerUsername, image: r.ownerImage },
      resolver:
        r.resolverId != null
          ? { id: r.resolverId, username: r.resolverUsername, image: r.resolverImage }
          : null,
      entity: s
        ? {
            id: s.id,
            title: s.title,
            path: ratingReviewEntityPath(t, s.id, s.parentId),
            nsfwLevel: s.nsfwLevel,
            override: s.override,
            coverUrl: s.coverUrl,
            coverType: s.coverType,
          }
        : null,
      scan: scans.get(t)?.get(r.entityId) ?? null,
      levelOptions: moderatorLevelsFor(t, r.currentLevel, s?.nsfwLevel),
    };
  });

  return { items, page, limit };
}

export async function getRatingReviewCounts(
  entityType?: RatingReviewEntityType
): Promise<Record<RatingReviewStatusFilter, number>> {
  let q = dbRead
    .selectFrom('RatingReview')
    .select((eb) => ['status', eb.fn.countAll<number>().as('count')])
    .groupBy('status');
  if (entityType) q = q.where('entityType', '=', entityType);
  const counts: Record<RatingReviewStatusFilter, number> = {
    Pending: 0,
    Actioned: 0,
    Unactioned: 0,
  };
  for (const r of await q.execute())
    if (r.status in counts) counts[r.status as RatingReviewStatusFilter] = Number(r.count);
  return counts;
}

export class RatingReviewResolveError extends Error {}

export type ResolveResult = {
  reviewId: number;
  entityType: RatingReviewEntityType;
  entityId: number;
  parentId: number | null;
  title: string;
  ownerUserId: number;
  previousLevel: number;
  status: ReportStatus;
  entityMissing: boolean;
  modelVersionIds: number[];
};

const JOB_QUEUE_TYPES = new Set<RatingReviewEntityType>([
  'Post',
  'Bounty',
  'BountyEntry',
  'Model',
  'Collection',
]);

const addLock = (prop: string) =>
  sql<string[]>`CASE WHEN ${prop} = ANY("lockedProperties") THEN "lockedProperties"
    ELSE array_append("lockedProperties", ${prop}) END`;

const gone = (entityType: RatingReviewEntityType) =>
  new RatingReviewResolveError(`That ${entityType} no longer exists; reload the queue.`);

const notApplicable = () =>
  new RatingReviewResolveError('That rating cannot be applied to this item');

function assertOne(result: { numUpdatedRows: bigint }, entityType: RatingReviewEntityType) {
  if (Number(result.numUpdatedRows) !== 1) throw gone(entityType);
}

type LiveChallenge = { nsfwLevel: number; allowedNsfwLevel: number; collectionId: number | null };
type LiveCrucible = { nsfwLevel: number; status: string; startAt: Date | null };

// Their level is an allowed-entry mask read live under a row lock, not the review's snapshot.
type MaskEntityType = 'Challenge' | 'Crucible';
type OverrideEntityType = Exclude<RatingReviewEntityType, MaskEntityType>;

async function applyOverride(
  trx: Transaction<DB>,
  entityType: OverrideEntityType,
  entityId: number,
  appliedLevel: number,
  basis: number
): Promise<void> {
  switch (entityType) {
    case 'Article':
      assertOne(
        await trx
          .updateTable('Article')
          .set({
            moderatorNsfwLevel: appliedLevel,
            moderatorNsfwLevelBasis: basis,
            nsfwLevel: appliedLevel,
            lockedProperties: addLock('userNsfwLevel'),
          })
          .where('id', '=', entityId)
          .executeTakeFirst(),
        entityType
      );
      break;
    case 'Model': {
      const nsfw = appliedLevel >= 4;
      const updated = await trx
        .updateTable('Model')
        .set({ nsfw, lockedProperties: addLock('nsfw') })
        .where('id', '=', entityId)
        .where('deletedAt', 'is', null)
        .$if(nsfw, (qb) =>
          qb.where('poi', '=', false).where('minor', '=', false).where('sfwOnly', '=', false)
        )
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 1) break;
      const flags = await trx
        .selectFrom('Model')
        .select(['poi', 'minor', 'sfwOnly'])
        .where('id', '=', entityId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (flags && (flags.poi || flags.minor || flags.sfwOnly))
        throw new RatingReviewResolveError(
          'A model flagged as POI, minor or SFW-only cannot be marked NSFW'
        );
      throw gone(entityType);
    }
    case 'Bounty':
      assertOne(
        await trx
          .updateTable('Bounty')
          .set({
            moderatorNsfwLevel: appliedLevel,
            moderatorNsfwLevelBasis: basis,
            nsfwLevel: appliedLevel,
            nsfw: (appliedLevel & nsfwBrowsingLevelsFlag) !== 0,
            lockedProperties: addLock('nsfw'),
          })
          .where('id', '=', entityId)
          .executeTakeFirst(),
        entityType
      );
      break;
    case 'Post':
      assertOne(
        await trx
          .updateTable('Post')
          .set({
            moderatorNsfwLevel: appliedLevel,
            moderatorNsfwLevelBasis: basis,
            nsfwLevel: appliedLevel,
          })
          .where('id', '=', entityId)
          .executeTakeFirst(),
        entityType
      );
      break;
    case 'BountyEntry':
      assertOne(
        await trx
          .updateTable('BountyEntry')
          .set({
            moderatorNsfwLevel: appliedLevel,
            moderatorNsfwLevelBasis: basis,
            nsfwLevel: appliedLevel,
          })
          .where('id', '=', entityId)
          .executeTakeFirst(),
        entityType
      );
      break;
    case 'Collection':
      assertOne(
        await trx
          .updateTable('Collection')
          .set({ moderatorNsfwLevel: appliedLevel, moderatorNsfwLevelBasis: appliedLevel })
          .where('id', '=', entityId)
          .executeTakeFirst(),
        entityType
      );
      break;
  }

  if (JOB_QUEUE_TYPES.has(entityType))
    await trx
      .insertInto('JobQueue')
      .values({ type: 'UpdateNsfwLevel', entityType: entityType as never, entityId })
      .onConflict((oc) => oc.columns(['entityType', 'entityId', 'type']).doNothing())
      .execute();
}

// The basis is the narrowed mask's level: deriving it from the mask being replaced would read as a
// content drop on the next look, and the derivation reads the mask this write sets.
async function applyChallengeOverride(
  trx: Transaction<DB>,
  entityId: number,
  live: LiveChallenge,
  appliedLevel: number
): Promise<void> {
  const allowed = challengeAllowedMaskAt(live.allowedNsfwLevel, appliedLevel);
  assertOne(
    await trx
      .updateTable('Challenge')
      .set({
        moderatorNsfwLevel: appliedLevel,
        moderatorNsfwLevelBasis: challengeDerivedNsfwLevel(allowed),
        nsfwLevel: appliedLevel,
        allowedNsfwLevel: allowed,
      })
      .where('id', '=', entityId)
      .executeTakeFirst(),
    'Challenge'
  );
  if (live.collectionId != null)
    await trx
      .updateTable('Collection')
      .set({
        metadata: sql`jsonb_set(COALESCE("metadata", '{}'::jsonb), '{forcedBrowsingLevel}', to_jsonb(${allowed}::int))`,
      })
      .where('id', '=', live.collectionId)
      .execute();
}

async function applyCrucibleOverride(
  trx: Transaction<DB>,
  entityId: number,
  live: LiveCrucible,
  appliedLevel: number
): Promise<void> {
  const allowed = challengeAllowedMaskAt(ratingBits(live.nsfwLevel), appliedLevel);
  assertOne(
    await trx
      .updateTable('Crucible')
      .set({
        moderatorNsfwLevel: appliedLevel,
        moderatorNsfwLevelBasis: challengeDerivedNsfwLevel(allowed),
        nsfwLevel: allowed | (live.nsfwLevel & ~allBrowsingLevelsFlag),
        textNsfw: appliedLevel >= NsfwLevel.R,
      })
      .where('id', '=', entityId)
      .executeTakeFirst(),
    'Crucible'
  );
}

async function entityExists(
  trx: Transaction<DB>,
  entityType: OverrideEntityType,
  entityId: number
): Promise<boolean> {
  // Every rating-review table has an integer `id`; the cast only narrows the union for Kysely.
  let q = trx
    .selectFrom(entityType as 'Post')
    .select('id')
    .where('id', '=', entityId);
  if (entityType === 'Model') q = q.where(sql<boolean>`"deletedAt" IS NULL`);
  return !!(await q.executeTakeFirst());
}

// Locked so an escalation cannot raise the level between the check below and the write.
const readLiveChallenge = (trx: Transaction<DB>, entityId: number) =>
  trx
    .selectFrom('Challenge')
    .select(['nsfwLevel', 'allowedNsfwLevel', 'collectionId'])
    .where('id', '=', entityId)
    .forUpdate()
    .executeTakeFirst();

const readLiveCrucible = (trx: Transaction<DB>, entityId: number) =>
  trx
    .selectFrom('Crucible')
    .select(['nsfwLevel', 'status', 'startAt'])
    .where('id', '=', entityId)
    .forUpdate()
    .executeTakeFirst();

export async function resolveRatingReview(input: {
  reviewId: number;
  appliedLevel: number;
  modComment?: string;
  moderatorId: number;
}): Promise<ResolveResult> {
  const { reviewId, appliedLevel, modComment, moderatorId } = input;

  const core = await dbWrite.transaction().execute(async (trx) => {
    const review = await trx
      .selectFrom('RatingReview')
      .select(['entityType', 'entityId', 'userId', 'currentLevel', 'suggestedLevel'])
      .where('id', '=', reviewId)
      .where('status', '=', ReportStatus.Pending)
      .executeTakeFirst();
    if (!review) throw new RatingReviewResolveError('Review already resolved');
    if (!isRatingReviewEntityType(review.entityType))
      throw new RatingReviewResolveError(`Unknown entity type ${review.entityType}`);
    const entityType = review.entityType;
    const entityId = review.entityId;

    let exists: boolean;
    let challenge: LiveChallenge | undefined;
    let crucible: LiveCrucible | undefined;
    let liveLevel: number | undefined;
    if (entityType === 'Challenge') {
      challenge = await readLiveChallenge(trx, entityId);
      exists = !!challenge;
      liveLevel = challenge?.nsfwLevel;
    } else if (entityType === 'Crucible') {
      crucible = await readLiveCrucible(trx, entityId);
      exists = !!crucible;
      liveLevel = crucible?.nsfwLevel;
    } else {
      exists = await entityExists(trx, entityType, entityId);
    }
    if (!moderatorLevelsFor(entityType, review.currentLevel, liveLevel).includes(appliedLevel))
      throw notApplicable();
    // The main app lets even a moderator change a crucible's levels only before it starts. Resolving
    // at the current level (a decline) leaves the mask as it is, so it stays available.
    if (
      crucible &&
      hasCrucibleStarted(crucible) &&
      challengeAllowedMaskAt(ratingBits(crucible.nsfwLevel), appliedLevel) !==
        ratingBits(crucible.nsfwLevel)
    )
      throw new RatingReviewResolveError(
        "This crucible has started; its allowed levels can't change."
      );

    const basis =
      exists &&
      entityType !== 'Model' &&
      entityType !== 'Challenge' &&
      entityType !== 'Crucible' &&
      entityType !== 'Collection'
        ? (await computeRatedEntityDerivedNsfwLevel(trx, entityType, entityId)) ?? 0
        : 0;
    const scanRow = exists
      ? await trx
          .selectFrom('EntityModeration')
          .select('result')
          .where('entityType', '=', entityType)
          .where('entityId', '=', entityId)
          .executeTakeFirst()
      : undefined;
    const status =
      exists && appliedLevel === review.suggestedLevel
        ? ReportStatus.Actioned
        : ReportStatus.Unactioned;

    const claim = await trx
      .updateTable('RatingReview')
      .set({
        status,
        resolvedAt: new Date(),
        resolvedBy: moderatorId,
        appliedLevel: exists ? appliedLevel : null,
        modComment: modComment ?? null,
        resolvedTextHash: textScanResultTextHash(scanRow?.result),
      })
      .where('id', '=', reviewId)
      .where('status', '=', ReportStatus.Pending)
      .executeTakeFirst();
    if (Number(claim.numUpdatedRows) !== 1)
      throw new RatingReviewResolveError('Review already resolved');

    if (challenge) await applyChallengeOverride(trx, entityId, challenge, appliedLevel);
    else if (crucible) await applyCrucibleOverride(trx, entityId, crucible, appliedLevel);
    else if (exists && entityType !== 'Challenge' && entityType !== 'Crucible')
      await applyOverride(trx, entityType, entityId, appliedLevel, basis);

    return {
      entityType,
      entityId,
      ownerUserId: review.userId,
      previousLevel: review.currentLevel,
      status,
      exists,
    };
  });

  const summary = core.exists
    ? (await loadSummaries(core.entityType, [core.entityId])).get(core.entityId)
    : undefined;
  const modelVersionIds =
    core.exists && core.entityType === 'Model'
      ? (
          await dbRead
            .selectFrom('ModelVersion')
            .select('id')
            .where('modelId', '=', core.entityId)
            .limit(500)
            .execute()
        ).map((v) => v.id)
      : [];

  return {
    reviewId,
    entityType: core.entityType,
    entityId: core.entityId,
    parentId: summary?.parentId ?? null,
    title: summary?.title ?? `${core.entityType} #${core.entityId}`,
    ownerUserId: core.ownerUserId,
    previousLevel: core.previousLevel,
    status: core.status,
    entityMissing: !core.exists,
    modelVersionIds,
  };
}
