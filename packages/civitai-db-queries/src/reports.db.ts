import { sql } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { kyselyRead, kyselyWrite } from './infra/client';

// The `Report.status`/`Report.reason` enums, derived from the schema so this module needs no separate enum
// import.
type ReportStatusValue = DB['Report']['status'];
type ReportReasonValue = DB['Report']['reason'];

// Each report points at its entity through a per-type join table (`<Entity>Report`: `{ reportId, <x>Id }`).
// A moderator views one entity type at a time, so a query joins only the active type rather than all 15.
const reportEntityJoin = {
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
} as const;

export type ReportEntity = keyof typeof reportEntityJoin;

export type ModeratorReportRow = {
  id: number;
  reason: ReportReasonValue;
  status: ReportStatusValue;
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
  statuses?: ReportStatusValue[];
  reasons?: ReportReasonValue[];
  reportedBy?: string;
};

// A page of reports of one entity type, newest first, with reporter identity, the also-reported count, and
// the reported entity's id (both via correlated subqueries against the type's join table). Returns the page
// items plus the total for pagination.
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

  // The join table/column is dynamic (one of 15), so these two use raw `sql`; the rest stays typed.
  const entityExists = sql<boolean>`exists (select 1 from ${sql.table(
    join.table
  )} er where er."reportId" = "Report"."id")`;
  const entityId = sql<number | null>`(select er.${sql.ref(join.fk)} from ${sql.table(
    join.table
  )} er where er."reportId" = "Report"."id" limit 1)`;

  let base = kyselyRead
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

// Set a report's moderator-only internal notes.
export function updateReportNotes(input: { id: number; internalNotes: string | null }) {
  return kyselyWrite
    .updateTable('Report')
    .set({ internalNotes: input.internalNotes })
    .where('id', '=', input.id)
    .execute();
}

// The status-transition SET clause. On Actioned, stamp how many reporters the report resolved.
const statusSet = (status: ReportStatusValue, userId: number) => ({
  status,
  statusSetAt: new Date(),
  statusSetBy: userId,
  ...(status === 'Actioned'
    ? { previouslyReviewedCount: sql<number>`coalesce(array_length("alsoReportedBy", 1), 0) + 1` }
    : {}),
});

// Transition one report; RETURNs the reporters only if the row actually changed (the `status != next`
// guard), so a caller can reward exactly once — a no-op re-transition returns undefined. Used by the
// moderator spoke. Follow-on side effects (rewards, activity) stay with the caller.
export function setReportStatus(input: { id: number; status: ReportStatusValue; userId: number }) {
  return kyselyWrite
    .updateTable('Report')
    .set(statusSet(input.status, input.userId))
    .where('id', '=', input.id)
    .where('status', '!=', input.status)
    .returning(['userId', 'alsoReportedBy'])
    .executeTakeFirst();
}

// Bulk variant: transition many reports in one atomic statement (no explicit transaction needed) and RETURN
// the changed rows' id + reporters. Used by the main app's bulkSetReportStatus.
export async function setReportStatusMany(input: {
  ids: number[];
  status: ReportStatusValue;
  userId: number;
}) {
  if (!input.ids.length) return [];
  return kyselyWrite
    .updateTable('Report')
    .set(statusSet(input.status, input.userId))
    .where('id', 'in', input.ids)
    .where('status', '!=', input.status)
    .returning(['id', 'userId', 'alsoReportedBy'])
    .execute();
}
