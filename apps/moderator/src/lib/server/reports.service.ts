import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
import { ReportEntity, ReportStatus, type ReportReason } from '$lib/reports';

// Each report points at its entity through a per-type join table (`<Entity>Report`: `{ reportId, <x>Id }`).
// The page queries one type at a time, so we join only the active type rather than all 15.
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

export async function setReportStatus({
  id,
  status,
  userId,
}: {
  id: number;
  status: ReportStatus;
  userId: number;
  ip?: string;
}) {
  await dbWrite
    .updateTable('Report')
    .set({
      status,
      statusSetAt: new Date(),
      statusSetBy: userId,
      // On Actioned, stamp how many reporters this resolved.
      ...(status === ReportStatus.Actioned
        ? { previouslyReviewedCount: sql<number>`coalesce(array_length("alsoReportedBy", 1), 0) + 1` }
        : {}),
    })
    .where('id', '=', id)
    .where('status', '!=', status)
    .execute();

  // `ModActivity` isn't in the slim Kysely schema → raw upsert.
  await sql`
    INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
    VALUES (${userId}, 'report', 'review', ${id})
    ON CONFLICT ("entityType", activity, "entityId") DO UPDATE SET "createdAt" = NOW(), "userId" = ${userId}
  `.execute(dbWrite);

  // TODO(moderator-migration): on Actioned the main app rewards reporters via `reportAcceptedReward`
  // (buzz, Wave 6) — deferred; reporters aren't rewarded from the moderator app until that's wired.
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
