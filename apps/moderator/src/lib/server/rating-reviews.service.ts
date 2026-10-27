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
import { cappedText } from './html-to-text';
import { modelCoverCount, modelCoverImages, MODEL_COVER_ORDER } from './model-covers';
import { postCoverRows } from './post-covers';
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
  /** Set for an Article only; every other type's cover is the first image of its preview set. */
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

const MODEL_COUNT_CAP = 5000;

type ModelCoverRow = RatingReviewImage & { modelId: number; total: number };

// Same order as the CSAM queue's covers (model-covers.ts); one lateral query for all ids.
async function modelCoverRows(ids: number[], limit: number): Promise<ModelCoverRow[]> {
  if (!ids.length) return [];
  const { rows } = await sql<ModelCoverRow>`
    SELECT m."id" AS "modelId", c.id, c.url, c.type, c."nsfwLevel", n.total
    FROM "Model" m
    CROSS JOIN LATERAL (${modelCoverImages(sql.ref('m.id'), sql.ref('m.userId'), limit)}) c
    CROSS JOIN LATERAL (${modelCoverCount(sql.ref('m.id'), sql.ref('m.userId'), MODEL_COUNT_CAP)}) n
    WHERE m."id" IN (${sql.join(ids)})
    ORDER BY m."id", ${MODEL_COVER_ORDER}`.execute(dbRead);
  return rows;
}

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
      // The one cover the preview set cannot give: the legacy `cover` string stands in for a missing
      // cover image, and a connected image must not replace it.
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
      for (const r of found)
        put({
          ...base,
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
      for (const r of found)
        put({
          ...base,
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
      for (const r of found)
        put({
          ...base,
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
      for (const r of found)
        put({
          ...base,
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
        .select(['id', 'title', 'nsfwLevel', 'moderatorNsfwLevel'])
        .where('id', 'in', ids)
        .execute();
      for (const r of found)
        put({
          ...base,
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
        .select(['id', 'name', 'nsfwLevel', 'moderatorNsfwLevel'])
        .where('id', 'in', ids)
        .execute();
      for (const r of found)
        put({
          ...base,
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
        .select(['id', 'name', 'nsfwLevel', 'moderatorNsfwLevel'])
        .where('id', 'in', ids)
        .execute();
      for (const r of found)
        put({
          ...base,
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

export type RatingReviewImages = { total: number; images: RatingReviewImage[] };

const imageKey = (entityType: RatingReviewEntityType, entityId: number) =>
  `${entityType}:${entityId}`;

const CONNECTION_CAP = 5000;

export const PREVIEW_LIMIT = 12;

/**
 * The images a moderator rates each entity from; `total` is the full count, `images` at most
 * `limit`. One query per entity type present, never one per entity. Keyed by `ratingReviewImagesKey`.
 */
async function loadImagesForType(
  entityType: RatingReviewEntityType,
  ids: number[],
  limit: number
): Promise<Map<number, RatingReviewImages>> {
  const out = new Map<number, RatingReviewImages>();
  if (!ids.length) return out;
  const group = (rows: (RatingReviewImage & { key: number; total: string | number })[]) => {
    for (const { key, total, ...img } of rows) {
      const entry = out.get(key) ?? { total: Number(total), images: [] };
      entry.images.push(img);
      out.set(key, entry);
    }
  };
  const single = async (imageIds: Map<number, number | null | undefined>) => {
    const byId = await imagesById([...imageIds.values()].map((v) => v ?? null));
    for (const [entityId, imageId] of imageIds) {
      const img = byId.get(imageId ?? 0);
      if (img) out.set(entityId, { total: 1, images: [img] });
    }
  };

  switch (entityType) {
    case 'Post': {
      const rows = await postCoverRows(ids, { limit });
      group(
        rows.map(({ postId, id, url, type, nsfwLevel, total }) => ({
          key: postId,
          id,
          url,
          type: type as MediaType,
          nsfwLevel,
          total,
        }))
      );
      return out;
    }
    case 'Model': {
      group(
        (await modelCoverRows(ids, limit)).map(({ modelId, ...img }) => ({ key: modelId, ...img }))
      );
      return out;
    }
    case 'Article':
    case 'Bounty':
    case 'BountyEntry': {
      const { rows: links } = await sql<{ entityId: number; imageId: number }>`
        SELECT "entityId", "imageId" FROM (
          SELECT "entityId", "imageId",
            row_number() OVER (PARTITION BY "entityId" ORDER BY "imageId") AS rn
          FROM "ImageConnection" ic
          WHERE "entityType" = ${entityType} AND "entityId" IN (${sql.join(ids)})
            AND EXISTS (SELECT 1 FROM "Image" i WHERE i."id" = ic."imageId")) x
        WHERE x.rn <= ${CONNECTION_CAP}
        ORDER BY "entityId", "imageId"`.execute(dbRead);
      const covers = new Map<number, number>();
      if (entityType === 'Article') {
        const found = await dbRead
          .selectFrom('Article')
          .select(['id', 'coverId'])
          .where('id', 'in', ids)
          .execute();
        const existing = await imagesById(found.map((a) => a.coverId));
        for (const a of found)
          if (a.coverId && existing.has(a.coverId)) covers.set(a.id, a.coverId);
      }
      // The cover leads, then connections by image id.
      const idsByEntity = new Map<number, number[]>();
      for (const id of ids) {
        const cover = covers.get(id);
        idsByEntity.set(id, cover ? [cover] : []);
      }
      for (const l of links) {
        const list = idsByEntity.get(l.entityId);
        if (list && !list.includes(l.imageId)) list.push(l.imageId);
      }
      const byId = await imagesById([...idsByEntity.values()].flatMap((l) => l.slice(0, limit)));
      for (const [entityId, list] of idsByEntity)
        if (list.length)
          out.set(entityId, {
            total: list.length,
            images: list.slice(0, limit).flatMap((id) => byId.get(id) ?? []),
          });
      return out;
    }
    case 'Challenge': {
      const found = await dbRead
        .selectFrom('Challenge')
        .select(['id', 'coverImageId'])
        .where('id', 'in', ids)
        .execute();
      await single(new Map(found.map((r) => [r.id, r.coverImageId])));
      return out;
    }
    case 'Crucible': {
      const found = await dbRead
        .selectFrom('Crucible')
        .select(['id', 'imageId', 'heroImageId'])
        .where('id', 'in', ids)
        .execute();
      await single(new Map(found.map((r) => [r.id, r.imageId ?? r.heroImageId])));
      return out;
    }
    case 'Collection': {
      const found = await dbRead
        .selectFrom('Collection')
        .select(['id', 'imageId'])
        .where('id', 'in', ids)
        .execute();
      await single(new Map(found.map((r) => [r.id, r.imageId])));
      return out;
    }
  }
}

/** A missing key means the entity has none. */
export async function getRatingReviewImagesBatch(
  entities: { entityType: RatingReviewEntityType; entityId: number }[],
  limit = PREVIEW_LIMIT
): Promise<Map<string, RatingReviewImages>> {
  const idsByType = new Map<RatingReviewEntityType, Set<number>>();
  for (const e of entities)
    idsByType.set(e.entityType, (idsByType.get(e.entityType) ?? new Set()).add(e.entityId));
  const loaded = await Promise.all(
    [...idsByType].map(
      async ([t, ids]) => [t, await loadImagesForType(t, [...ids], limit)] as const
    )
  );
  const out = new Map<string, RatingReviewImages>();
  for (const [t, found] of loaded) for (const [id, v] of found) out.set(imageKey(t, id), v);
  return out;
}

export async function getRatingReviewImages(
  entityType: RatingReviewEntityType,
  entityId: number,
  limit = PREVIEW_LIMIT
): Promise<RatingReviewImages> {
  const found = await getRatingReviewImagesBatch([{ entityType, entityId }], limit);
  return found.get(imageKey(entityType, entityId)) ?? { total: 0, images: [] };
}

export const ratingReviewImagesKey = imageKey;

export type ScannedTextField = { heading: string; text: string };
export type ScannedText = { fields: ScannedTextField[]; truncated: boolean };

const SCANNED_FIELD_CAP = 6000;
const SCANNED_TEXT_CAP = 12000;

type RawField = { heading: string; text: string | null | undefined; html?: boolean };

/** Plain text, with stored HTML stripped; fields and the whole are capped so long articles stay small. */
function composeScannedText(raw: RawField[]): ScannedText {
  const fields: ScannedTextField[] = [];
  let used = 0;
  let truncated = false;
  for (const { heading, text, html } of raw) {
    const capped = html
      ? cappedText(text, SCANNED_FIELD_CAP)
      : text?.trim()
      ? {
          text: text.trim().slice(0, SCANNED_FIELD_CAP),
          truncated: text.trim().length > SCANNED_FIELD_CAP,
        }
      : null;
    if (!capped) continue;
    const room = SCANNED_TEXT_CAP - used;
    if (room <= 0) {
      truncated = true;
      break;
    }
    const kept = capped.text.slice(0, room);
    fields.push({ heading, text: kept });
    used += kept.length;
    if (capped.truncated || kept.length < capped.text.length) truncated = true;
  }
  return { fields, truncated };
}

const joinedThemeElements = (metadata: unknown) => {
  const list = (metadata as { themeElements?: unknown } | null)?.themeElements;
  return Array.isArray(list) ? list.filter((e) => typeof e === 'string').join(', ') : null;
};

/** Mirrors what the main app's text scan reads (src/server/services/text-scan/profiles/*); a Model's version text covers public versions only, as the scan does. */
async function loadScannedTextForType(
  entityType: RatingReviewEntityType,
  ids: number[]
): Promise<Map<number, RawField[]>> {
  const out = new Map<number, RawField[]>();
  if (!ids.length) return out;
  switch (entityType) {
    case 'Post': {
      const found = await dbRead
        .selectFrom('Post')
        .select(['id', 'title', 'detail'])
        .where('id', 'in', ids)
        .execute();
      for (const r of found)
        out.set(r.id, [
          { heading: 'Title', text: r.title },
          { heading: 'Detail', text: r.detail, html: true },
        ]);
      return out;
    }
    case 'Article': {
      const found = await dbRead
        .selectFrom('Article')
        .select(['id', 'title', 'content'])
        .where('id', 'in', ids)
        .execute();
      for (const r of found)
        out.set(r.id, [
          { heading: 'Title', text: r.title },
          { heading: 'Content', text: r.content, html: true },
        ]);
      return out;
    }
    case 'Model': {
      const [found, versions] = await Promise.all([
        dbRead
          .selectFrom('Model')
          .select(['id', 'name', 'description'])
          .where('id', 'in', ids)
          .execute(),
        dbRead
          .selectFrom('ModelVersion')
          .select(['modelId', 'name', 'description', 'trainedWords'])
          .where('modelId', 'in', ids)
          .where('status', 'in', ['Published', 'Scheduled'])
          .orderBy('modelId')
          .orderBy('index')
          .execute(),
      ]);
      for (const r of found)
        out.set(r.id, [
          { heading: 'Name', text: r.name },
          { heading: 'Description', text: r.description, html: true },
        ]);
      for (const v of versions)
        out
          .get(v.modelId)
          ?.push(
            { heading: 'Version name', text: v.name },
            { heading: 'Version description', text: v.description, html: true },
            { heading: 'Trained words', text: v.trainedWords.join(', ') }
          );
      return out;
    }
    case 'Bounty': {
      const found = await dbRead
        .selectFrom('Bounty')
        .select(['id', 'name', 'description'])
        .where('id', 'in', ids)
        .execute();
      for (const r of found)
        out.set(r.id, [
          { heading: 'Name', text: r.name },
          { heading: 'Description', text: r.description, html: true },
        ]);
      return out;
    }
    case 'BountyEntry': {
      const found = await dbRead
        .selectFrom('BountyEntry')
        .select(['id', 'description'])
        .where('id', 'in', ids)
        .execute();
      for (const r of found)
        out.set(r.id, [{ heading: 'Description', text: r.description, html: true }]);
      return out;
    }
    case 'Challenge': {
      const found = await dbRead
        .selectFrom('Challenge')
        .select(['id', 'title', 'theme', 'description', 'invitation', 'metadata'])
        .where('id', 'in', ids)
        .execute();
      for (const r of found)
        out.set(r.id, [
          { heading: 'Title', text: r.title },
          { heading: 'Theme', text: r.theme },
          { heading: 'Theme elements', text: joinedThemeElements(r.metadata) },
          { heading: 'Description', text: r.description, html: true },
          { heading: 'Invitation', text: r.invitation },
        ]);
      return out;
    }
    case 'Crucible':
    case 'Collection': {
      const found = await dbRead
        .selectFrom(entityType)
        .select(['id', 'name', 'description'])
        .where('id', 'in', ids)
        .execute();
      for (const r of found)
        out.set(r.id, [
          { heading: 'Name', text: r.name },
          { heading: 'Description', text: r.description, html: true },
        ]);
      return out;
    }
  }
}

export async function getRatingReviewScannedTextBatch(
  entities: { entityType: RatingReviewEntityType; entityId: number }[]
): Promise<Map<string, ScannedText>> {
  const idsByType = new Map<RatingReviewEntityType, Set<number>>();
  for (const e of entities)
    idsByType.set(e.entityType, (idsByType.get(e.entityType) ?? new Set()).add(e.entityId));
  const loaded = await Promise.all(
    [...idsByType].map(async ([t, ids]) => [t, await loadScannedTextForType(t, [...ids])] as const)
  );
  const out = new Map<string, ScannedText>();
  for (const [t, found] of loaded)
    for (const [id, raw] of found) {
      const composed = composeScannedText(raw);
      if (composed.fields.length) out.set(imageKey(t, id), composed);
    }
  return out;
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

/** The review list's shared select: a review, its owner and its resolver. Callers add the filters. */
export function ratingReviewRowQuery() {
  return dbRead
    .selectFrom('RatingReview as rr')
    .innerJoin('User as owner', 'owner.id', 'rr.userId')
    .leftJoin('User as resolver', 'resolver.id', 'rr.resolvedBy')
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
    ]);
}

type ReviewRecord = Awaited<ReturnType<ReturnType<typeof ratingReviewRowQuery>['execute']>>[number];

/** Turns raw review records into rows: entity summaries, text scans and the levels a moderator may apply. */
export async function hydrateRatingReviews(records: ReviewRecord[]): Promise<RatingReviewRow[]> {
  const found = records.filter((r) => isRatingReviewEntityType(r.entityType));

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

  return found.map((r): RatingReviewRow => {
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
        resolvedAt: sql`now()`,
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
