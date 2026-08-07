import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
import { recordModActivity } from './mod-activity';
import { rewardReportReporters } from './rewards';
import {
  DEFAULT_REPORT_REASONS,
  DEFAULT_REPORT_STATUSES,
  ReportStatus,
  reportCountKey,
  type ReportEntity,
  type ReportReason,
} from '$lib/reports';

const reportEntityJoin: Record<ReportEntity, { table: string; fk: string }> = {
  model: { table: 'ModelReport', fk: 'modelId' },
  comment: { table: 'CommentReport', fk: 'commentId' },
  commentV2: { table: 'CommentV2Report', fk: 'commentV2Id' },
  image: { table: 'ImageReport', fk: 'imageId' },
  resourceReview: { table: 'ResourceReviewReport', fk: 'resourceReviewId' },
  article: { table: 'ArticleReport', fk: 'articleId' },
  post: { table: 'PostReport', fk: 'postId' },
  reportedUser: { table: 'UserReport', fk: 'userId' },
  collection: { table: 'CollectionReport', fk: 'collectionId' },
  bounty: { table: 'BountyReport', fk: 'bountyId' },
  bountyEntry: { table: 'BountyEntryReport', fk: 'bountyEntryId' },
  chat: { table: 'ChatReport', fk: 'chatId' },
  comicProject: { table: 'ComicProjectReport', fk: 'comicProjectId' },
  model3d: { table: 'Model3DReport', fk: 'model3dId' },
  model3dReview: { table: 'Model3DReviewReport', fk: 'model3dReviewId' },
};

export type ModeratorReportRow = {
  id: number;
  reason: ReportReason;
  status: ReportStatus;
  createdAt: Date;
  internalNotes: string | null;
  details: unknown;
  reportedByUsername: string | null;
  reportedByEmail: string | null;
  alsoReportedByCount: number;
  entityId: number | null;
};

export type GetReportsParams = {
  type: ReportEntity;
  page?: number;
  limit?: number;
  statuses?: ReportStatus[];
  reasons?: ReportReason[];
  reportedBy?: string;
};

export async function getReports({
  type,
  page = 1,
  limit = 20,
  statuses,
  reasons,
  reportedBy,
}: GetReportsParams): Promise<{
  items: ModeratorReportRow[];
  totalItems: number;
  page: number;
  limit: number;
}> {
  const join = reportEntityJoin[type];
  const offset = (page - 1) * limit;

  // The join table/column is dynamic, so these two use raw `sql`; the rest of the query stays typed.
  const entityExists = sql<boolean>`exists (select 1 from ${sql.table(
    join.table
  )} er where er."reportId" = "Report"."id")`;
  const entityId = sql<number | null>`(select er.${sql.ref(join.fk)} from ${sql.table(
    join.table
  )} er where er."reportId" = "Report"."id" limit 1)`;

  let base = dbRead
    .selectFrom('Report')
    .leftJoin('User', 'User.id', 'Report.userId')
    .where(entityExists);

  if (statuses?.length) base = base.where('Report.status', 'in', statuses);
  if (reasons?.length) base = base.where('Report.reason', 'in', reasons);
  if (reportedBy) base = base.where('User.username', 'ilike', `${reportedBy}%`);

  const totalItems = Number(
    (await base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirst())?.count ?? 0
  );

  const items = (await base
    .select([
      'Report.id',
      'Report.reason',
      'Report.status',
      'Report.createdAt',
      'Report.internalNotes',
      'Report.details',
      'User.username as reportedByUsername',
      'User.email as reportedByEmail',
    ])
    .select(
      sql<number>`coalesce(array_length("Report"."alsoReportedBy", 1), 0)`.as('alsoReportedByCount')
    )
    .select(entityId.as('entityId'))
    .orderBy('Report.id', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()) as ModeratorReportRow[];

  return { items, totalItems, page, limit };
}

// Counted with the same filters the report pages land on, so a sub-nav badge matches the rows you get when
// you click it.
export async function getReportCounts(): Promise<Record<string, number>> {
  const statuses = sql.join(DEFAULT_REPORT_STATUSES.map((s) => sql.lit(s)));
  const reasons = sql.join(DEFAULT_REPORT_REASONS.map((r) => sql.lit(r)));
  // One pass over Report (rides Report_open_reason_id_idx), then each report table joins the result —
  // per-branch joins back to Report seq-scanned it once per entity type.
  const open = sql`select "id" from "Report"
    where "status" in (${statuses}) and "reason" in (${reasons})`;
  const branches = Object.entries(reportEntityJoin).map(
    ([type, join]) => sql`select ${sql.lit(type)} as type, count(*)::int as count
      from ${sql.table(join.table)} er
      join open_reports o on o."id" = er."reportId"`
  );
  const { rows } = await sql<{ type: string; count: number }>`with open_reports as materialized (${open})
    ${sql.join(branches, sql` union all `)}`.execute(dbRead);

  return Object.fromEntries(
    rows.map((row) => [reportCountKey(row.type as ReportEntity), Number(row.count)])
  );
}

export async function setReportStatus({
  id,
  status,
  userId,
  ip,
}: {
  id: number;
  status: ReportStatus;
  userId: number;
  ip?: string;
}) {
  const updated = await dbWrite
    .updateTable('Report')
    .set({
      status,
      statusSetAt: new Date(),
      statusSetBy: userId,
      ...(status === ReportStatus.Actioned
        ? {
            previouslyReviewedCount: sql<number>`coalesce(array_length("alsoReportedBy", 1), 0) + 1`,
          }
        : {}),
    })
    .where('id', '=', id)
    .where('status', '!=', status)
    .returning(['userId', 'alsoReportedBy'])
    .executeTakeFirst();

  await recordModActivity({ userId, entityType: 'report', entityId: id, activity: 'review' });

  // `updated` is set only when the row actually changed, so re-actioning an already-Actioned report never
  // double-rewards.
  if (status === ReportStatus.Actioned && updated) {
    const reporterIds = [updated.userId, ...(updated.alsoReportedBy ?? [])];
    await rewardReportReporters({ reportId: id, reporterIds, ip });
  }
}

export async function updateReportNotes({
  id,
  internalNotes,
}: {
  id: number;
  internalNotes: string | null;
}) {
  await dbWrite.updateTable('Report').set({ internalNotes }).where('id', '=', id).execute();
}

export type MostReportedRow = {
  id: number;
  reason: ReportReason;
  createdAt: Date;
  reportCount: number;
  entity: 'image' | 'model' | 'post' | 'article' | 'reportedUser' | 'other';
  entityId: number | null;
  reportedByUsername: string | null;
};

// Content the community is piling reports onto — the signal moderators use to find the worst
// live content fast. Excludes images already blocked, since those are handled.
const MOST_REPORTED_TTL_MS = 60_000;
let mostReportedCache: { at: number; value: Promise<MostReportedRow[]> } | null = null;

export function getMostReported(limit = 20, now = Date.now()): Promise<MostReportedRow[]> {
  if (mostReportedCache && now - mostReportedCache.at < MOST_REPORTED_TTL_MS)
    return mostReportedCache.value;
  const value = fetchMostReported(limit);
  mostReportedCache = { at: now, value };
  value.catch(() => {
    if (mostReportedCache?.value === value) mostReportedCache = null;
  });
  return value;
}

async function fetchMostReported(limit: number): Promise<MostReportedRow[]> {
  // `alsoReportedBy` is a Postgres array and the ordering key, so array_length stays raw sql.
  const reportCount = sql<number>`array_length(t."alsoReportedBy", 1)`;
  const rows = await dbRead
    .selectFrom('Report as t')
    .leftJoin('ImageReport as ir', 'ir.reportId', 't.id')
    .leftJoin('ModelReport as mr', 'mr.reportId', 't.id')
    .leftJoin('UserReport as ur', 'ur.reportId', 't.id')
    .leftJoin('PostReport as pr', 'pr.reportId', 't.id')
    .leftJoin('ArticleReport as ar', 'ar.reportId', 't.id')
    .leftJoin('Image as i', 'i.id', 'ir.imageId')
    .innerJoin('User as u', 'u.id', 't.userId')
    .select([
      't.id',
      't.reason',
      't.createdAt',
      'ir.imageId',
      'mr.modelId',
      'ur.userId as reportedUserId',
      'pr.postId',
      'ar.articleId',
      'u.username as reportedByUsername',
      reportCount.as('reportCount'),
    ])
    .where('t.status', '=', ReportStatus.Pending)
    .where(reportCount, '>', 1)
    .where('t.createdAt', '>', sql<Date>`now() - interval '1 week'`)
    .where('i.blockedFor', 'is', null)
    .orderBy(reportCount, 'desc')
    .orderBy('t.createdAt', 'desc')
    .limit(limit)
    .execute();

  return rows.map((r) => {
    const [entity, entityId] = r.imageId
      ? (['image', r.imageId] as const)
      : r.modelId
      ? (['model', r.modelId] as const)
      : r.postId
      ? (['post', r.postId] as const)
      : r.articleId
      ? (['article', r.articleId] as const)
      : r.reportedUserId
      ? (['reportedUser', r.reportedUserId] as const)
      : (['other', null] as const);
    return {
      id: r.id,
      reason: r.reason as ReportReason,
      createdAt: r.createdAt,
      reportCount: Number(r.reportCount ?? 0),
      entity,
      entityId,
      reportedByUsername: r.reportedByUsername,
    };
  });
}
