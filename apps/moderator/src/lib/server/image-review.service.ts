import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import type { MediaType } from '$lib/media/edge-url';
import type { ImageReviewType } from '$lib/image-review';

export type ReviewTag = { id: number; name: string; nsfwLevel: number };

export type ImageReviewItem = {
  id: number;
  url: string;
  nsfwLevel: number;
  width: number | null;
  height: number | null;
  type: MediaType;
  needsReview: string | null;
  blockedFor: string | null;
  minor: boolean;
  poi: boolean;
  acceptableMinor: boolean;
  ruleReason: string | null;
  ruleId: number | null;
  profilePicture: boolean | null;
  prompt: string | null;
  negativePrompt: string | null;
  createdAt: Date;
  userId: number;
  username: string | null;
  userImage: string | null;
  postId: number | null;
  postTitle: string | null;
  entityType: string | null;
  entityId: number | null;
  reviewTags: ReviewTag[];
};

// The AI-flagged moderation review queue for a single `needsReview` type (minor/tag/newUser/modRule/
// remixSource). Ported from image.service `getImageModerationReviewQueue` (needsReview branch). The
// `needsReview = value AND ingestion = 'Scanned'` filter rides the partial index `Image_needsReview_index`
// — fast (the whole queue is a few hundred rows). ImageConnection is joined LATERAL-LIMIT-1 so a
// multiply-connected image can't duplicate rows (which would also break cursor paging).
export async function getImageReviewQueue({
  needsReview,
  tagIds,
  excludedTagIds,
  browsingLevel,
  cursor,
  limit,
}: {
  needsReview: ImageReviewType;
  tagIds?: number[];
  excludedTagIds?: number[];
  browsingLevel: number;
  cursor?: number;
  limit: number;
}): Promise<{ items: ImageReviewItem[]; nextCursor?: number }> {
  const rows = await dbRead
    .selectFrom('Image as i')
    .innerJoin('User as u', 'u.id', 'i.userId')
    .leftJoin('Post as p', 'p.id', 'i.postId')
    // One ImageConnection per image (a multiply-connected image would otherwise duplicate rows + break
    // cursor paging). LATERAL … LIMIT 1 keeps it a correlated per-image lookup — a plain distinctOn
    // subquery would DISTINCT the whole (580k-row) table first (~370ms vs ~8ms).
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('ImageConnection as c')
          .select(['c.entityType', 'c.entityId'])
          .whereRef('c.imageId', '=', 'i.id')
          .limit(1)
          .as('ic'),
      (join) => join.onTrue()
    )
    .select([
      'i.id',
      'i.url',
      'i.nsfwLevel',
      'i.width',
      'i.height',
      'i.type',
      'i.needsReview',
      'i.blockedFor',
      'i.minor',
      'i.poi',
      'i.acceptableMinor',
      sql<string | null>`i.metadata ->> 'ruleReason'`.as('ruleReason'),
      sql<number | null>`(i.metadata ->> 'ruleId')::int`.as('ruleId'),
      sql<boolean | null>`(i.metadata ->> 'profilePicture')::boolean`.as('profilePicture'),
      sql<string | null>`i.meta ->> 'prompt'`.as('prompt'),
      sql<string | null>`i.meta ->> 'negativePrompt'`.as('negativePrompt'),
      'i.createdAt',
      'i.userId',
      'u.username',
      'u.image as userImage',
      'i.postId',
      'p.title as postTitle',
      'ic.entityType',
      'ic.entityId',
    ])
    // needsReview + ingestion equality drives the Image_needsReview_index partial index. The bit-op
    // browsing-level test and the correlated tag EXISTS/NOT EXISTS subqueries stay as sql fragments.
    .where(sql<boolean>`(i."nsfwLevel" = 0 OR (i."nsfwLevel" & ${browsingLevel}) != 0)`)
    .where('i.needsReview', '=', needsReview)
    .where('i.ingestion', '=', 'Scanned')
    .$if(!!tagIds?.length, (qb) =>
      qb.where(
        sql<boolean>`EXISTS (SELECT 1 FROM "TagsOnImageDetails" toi WHERE toi."imageId" = i.id AND toi."tagId" IN (${sql.join(
          tagIds!
        )}))`
      )
    )
    .$if(!!excludedTagIds?.length, (qb) =>
      qb.where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM "ImageTagForReview" toi WHERE toi."imageId" = i.id AND toi."tagId" IN (${sql.join(
          excludedTagIds!
        )}))`
      )
    )
    .$if(cursor != null, (qb) => qb.where('i.id', '<', cursor!))
    .orderBy('i.id', 'desc')
    .limit(limit + 1)
    .execute();

  let nextCursor: number | undefined;
  if (limit && rows.length > limit) nextCursor = Number(rows.pop()?.id);

  const ids = rows.map((r) => r.id);
  const tagsByImage = new Map<number, ReviewTag[]>();
  if (ids.length) {
    const tags = await dbRead
      .selectFrom('ImageTagForReview as itr')
      .innerJoin('Tag as t', 't.id', 'itr.tagId')
      .select(['itr.imageId', 't.id', 't.name', 't.nsfwLevel'])
      .where('itr.imageId', 'in', ids)
      .execute();
    for (const { imageId, ...tag } of tags) {
      const arr = tagsByImage.get(imageId) ?? [];
      arr.push(tag);
      tagsByImage.set(imageId, arr);
    }
  }

  return {
    items: rows.map((r) => ({ ...r, reviewTags: tagsByImage.get(r.id) ?? [] })),
    nextCursor,
  };
}

// ModerationRule.definition (jsonb) keyed by id, for the modRule card's "rule definition" popover.
export async function getModerationRuleDefinitions(
  ruleIds: number[]
): Promise<Record<number, unknown>> {
  const ids = [...new Set(ruleIds)];
  if (!ids.length) return {};
  const rows = await dbRead
    .selectFrom('ModerationRule')
    .select(['id', 'definition'])
    .where('id', 'in', ids)
    .execute();
  return Object.fromEntries(rows.map((r) => [r.id, r.definition]));
}

// Distinct review tags present on images in a given review queue — the include/exclude filter options
// (ported from tag.getTagsForReview). Capped at 100 like the legacy.
export async function getReviewQueueTags(
  needsReview: ImageReviewType
): Promise<{ id: number; name: string }[]> {
  return dbRead
    .selectFrom('ImageTagForReview as itr')
    .innerJoin('Tag as t', 't.id', 'itr.tagId')
    .innerJoin('Image as i', 'i.id', 'itr.imageId')
    .where('i.needsReview', '=', needsReview)
    .select(['t.id', 't.name'])
    .distinct()
    .orderBy('t.name')
    .limit(100)
    .execute();
}

// Tab badge counts for the /images sub-tabs only — the needsReview values. The main app's counts query
// also UNIONs a `reported` bucket (a ~200K-row seq scan on Report — no status index) and `appeal`; those
// live on their own pages now, so dropping them here takes this from ~445ms to ~2ms.
export async function getImageReviewCounts(): Promise<Record<string, number>> {
  const rows = await dbRead
    .selectFrom('Image')
    .select('needsReview')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('needsReview', 'is not', null)
    .where('needsReview', '!=', 'appeal')
    .where('ingestion', '=', 'Scanned')
    .groupBy('needsReview')
    .execute();
  return Object.fromEntries(rows.map((r) => [r.needsReview!, Number(r.count)]));
}

export type ReportedImageItem = {
  id: number;
  url: string;
  nsfwLevel: number;
  width: number | null;
  height: number | null;
  type: MediaType;
  needsReview: string | null;
  userId: number;
  username: string | null;
  report: {
    id: number;
    reason: string;
    status: string;
    details: unknown;
    count: number;
    createdAt: Date;
    username: string | null;
    userId: number;
  };
};

// The "Reported" queue: images with a PENDING user report, oldest-first. Ported from
// getImageModerationReviewQueue (reportReview branch). One row PER report (an image with several pending
// reports appears once per report, as in the main app). Ordered by report.id ASC (monotonic with creation
// → oldest-first + a clean unique cursor) — needs the `Report_pending_id_idx` partial index (see the
// migration) or it seq-scans ~400k pending rows.
export async function getReportedImageQueue({
  browsingLevel,
  cursor,
  limit,
}: {
  browsingLevel: number;
  cursor?: number;
  limit: number;
}): Promise<{ items: ReportedImageItem[]; nextCursor?: number }> {
  const rows = await dbRead
    .selectFrom('Image as i')
    .innerJoin('User as u', 'u.id', 'i.userId')
    .innerJoin('ImageReport as imgr', 'imgr.imageId', 'i.id')
    .innerJoin('Report as r', 'r.id', 'imgr.reportId')
    .innerJoin('User as ru', 'ru.id', 'r.userId')
    .select([
      'i.id',
      'i.url',
      'i.nsfwLevel',
      'i.width',
      'i.height',
      'i.type',
      'i.needsReview',
      'i.userId',
      'u.username',
      'r.id as reportId',
      'r.reason as reportReason',
      'r.status as reportStatus',
      'r.details as reportDetails',
      'r.createdAt as reportCreatedAt',
      sql<number>`coalesce(array_length(r."alsoReportedBy", 1), 0)`.as('reportCount'),
      'ru.username as reportUsername',
      'ru.id as reportUserId',
    ])
    .where(sql<boolean>`(i."nsfwLevel" = 0 OR (i."nsfwLevel" & ${browsingLevel}) != 0)`)
    .where('r.status', '=', 'Pending')
    .$if(cursor != null, (qb) => qb.where('r.id', '>', cursor!))
    .orderBy('r.id', 'asc')
    .limit(limit + 1)
    .execute();

  let nextCursor: number | undefined;
  if (limit && rows.length > limit) nextCursor = Number(rows.pop()?.reportId);

  const items: ReportedImageItem[] = rows.map((r) => ({
    id: r.id,
    url: r.url,
    nsfwLevel: r.nsfwLevel,
    width: r.width,
    height: r.height,
    type: r.type,
    needsReview: r.needsReview,
    userId: r.userId,
    username: r.username,
    report: {
      id: r.reportId,
      reason: String(r.reportReason),
      status: String(r.reportStatus),
      details: r.reportDetails,
      count: Number(r.reportCount),
      createdAt: r.reportCreatedAt,
      username: r.reportUsername,
      userId: r.reportUserId,
    },
  }));
  return { items, nextCursor };
}

export type AppealReportRow = {
  id: number;
  reason: string;
  status: string;
  details: unknown;
  createdAt: Date;
  username: string | null;
  userId: number;
};

export type AppealImageItem = {
  id: number;
  url: string;
  nsfwLevel: number;
  width: number | null;
  height: number | null;
  type: MediaType;
  needsReview: string | null;
  blockedFor: string | null;
  userId: number;
  username: string | null;
  appeal: { id: number; message: string; createdAt: Date; username: string | null; userId: number };
  moderatorUsername: string | null;
  removedAt: Date | null;
  tosReason: string | null;
  reports: AppealReportRow[];
};

// The "Appeals" queue (senior): images the owner appealed (needsReview='appeal' — no ingestion gate, so
// blocked images stay visible). Ported from getImageModerationReviewQueue (appeal branch): newest Appeal
// per image + appellant, plus the moderator + removedAt from the 'review' ModActivity. Enriched with the
// ClickHouse `tosReason` (why it was removed) and the reports that triggered removal (capped 5/image).
export async function getAppealImageQueue({
  browsingLevel,
  cursor,
  limit,
}: {
  browsingLevel: number;
  cursor?: number;
  limit: number;
}): Promise<{ items: AppealImageItem[]; nextCursor?: number }> {
  const rows = await dbRead
    .selectFrom('Image as i')
    .innerJoin('User as u', 'u.id', 'i.userId')
    .innerJoinLateral(
      (eb) =>
        eb
          .selectFrom('Appeal as a')
          .select(['a.id', 'a.appealMessage', 'a.createdAt', 'a.userId'])
          .where('a.entityType', '=', 'Image')
          .whereRef('a.entityId', '=', 'i.id')
          .orderBy('a.createdAt', 'desc')
          .limit(1)
          .as('appeal'),
      (join) => join.onTrue()
    )
    .innerJoin('User as au', 'au.id', 'appeal.userId')
    .leftJoin('ModActivity as ma', (join) =>
      join
        .onRef('ma.entityId', '=', 'i.id')
        .on('ma.entityType', '=', 'image')
        .on('ma.activity', '=', 'review')
    )
    .leftJoin('User as mu', 'mu.id', 'ma.userId')
    .select([
      'i.id',
      'i.url',
      'i.nsfwLevel',
      'i.width',
      'i.height',
      'i.type',
      'i.needsReview',
      'i.blockedFor',
      'i.userId',
      'u.username',
      'appeal.id as appealId',
      'appeal.appealMessage as appealMessage',
      'appeal.createdAt as appealCreatedAt',
      'appeal.userId as appealUserId',
      'au.username as appealUsername',
      'mu.username as moderatorUsername',
      'ma.createdAt as removedAt',
    ])
    .where(sql<boolean>`(i."nsfwLevel" = 0 OR (i."nsfwLevel" & ${browsingLevel}) != 0)`)
    .where('i.needsReview', '=', 'appeal')
    .$if(cursor != null, (qb) => qb.where('i.id', '<', cursor!))
    .orderBy('i.id', 'desc')
    .limit(limit + 1)
    .execute();

  let nextCursor: number | undefined;
  if (limit && rows.length > limit) nextCursor = Number(rows.pop()?.id);

  const ids = rows.map((r) => r.id);
  const tosByImage = new Map<number, string>();
  const reportsByImage = new Map<number, AppealReportRow[]>();
  if (ids.length) {
    // Why the image was removed (DeleteTOS scan event) — ClickHouse. Best-effort: an appeal card without
    // the tosReason is still usable.
    try {
      const resp = await getClickhouse().query({
        query: `SELECT imageId, tosReason FROM images WHERE imageId IN ({ids:Array(Int32)}) AND type = 'DeleteTOS' AND tosReason IS NOT NULL`,
        query_params: { ids },
        format: 'JSONEachRow',
      });
      for (const t of await resp.json<{ imageId: number; tosReason: string }[]>())
        tosByImage.set(t.imageId, t.tosReason);
    } catch (e) {
      console.error('[appeals] tosReason lookup failed', e);
    }

    const reportRows = await dbRead
      .selectFrom('ImageReport as imgr')
      .innerJoin('Report as r', 'r.id', 'imgr.reportId')
      .innerJoin('User as ru', 'ru.id', 'r.userId')
      .select([
        'imgr.imageId',
        'r.id',
        'r.reason',
        'r.status',
        'r.details',
        'r.createdAt',
        'ru.username',
        'ru.id as userId',
      ])
      .where('imgr.imageId', 'in', ids)
      .orderBy('r.createdAt', 'desc')
      .execute();
    for (const row of reportRows) {
      const list = reportsByImage.get(row.imageId) ?? [];
      if (list.length < 5)
        list.push({
          id: row.id,
          reason: String(row.reason),
          status: String(row.status),
          details: row.details,
          createdAt: row.createdAt,
          username: row.username,
          userId: row.userId,
        });
      reportsByImage.set(row.imageId, list);
    }
  }

  const items: AppealImageItem[] = rows.map((r) => ({
    id: r.id,
    url: r.url,
    nsfwLevel: r.nsfwLevel,
    width: r.width,
    height: r.height,
    type: r.type,
    needsReview: r.needsReview,
    blockedFor: r.blockedFor,
    userId: r.userId,
    username: r.username,
    appeal: {
      id: r.appealId,
      message: r.appealMessage,
      createdAt: r.appealCreatedAt,
      username: r.appealUsername,
      userId: r.appealUserId,
    },
    moderatorUsername: r.moderatorUsername,
    removedAt: r.removedAt,
    tosReason: tosByImage.get(r.id) ?? null,
    reports: reportsByImage.get(r.id) ?? [],
  }));
  return { items, nextCursor };
}
