import { sql, type Kysely, type Updateable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { toJson } from './infra/helpers';

// Query functions take a Kysely client (or transaction) as their first argument — the caller decides which
// tier (read/write/replica) or transaction the query runs on. `Transaction<DB>` satisfies `Kysely<DB>`, so a
// caller can pass an open transaction to compose several statements atomically.

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
// guard), so a caller can reward exactly once — a no-op re-transition returns undefined. Follow-on side
// effects (rewards, activity) stay with the caller.
export function setReportStatus(
  db: Kysely<DB>,
  input: { id: number; status: ReportStatusValue; userId: number }
) {
  return db
    .updateTable('Report')
    .set(statusSet(input.status, input.userId))
    .where('id', '=', input.id)
    .where('status', '!=', input.status)
    .returning(['userId', 'alsoReportedBy'])
    .executeTakeFirst();
}

// Bulk variant: transition many reports in one atomic statement (no explicit transaction needed) and RETURN
// the changed rows' id + reporters.
export async function setReportStatusMany(
  db: Kysely<DB>,
  input: { ids: number[]; status: ReportStatusValue; userId: number }
) {
  if (!input.ids.length) return [];
  return db
    .updateTable('Report')
    .set(statusSet(input.status, input.userId))
    .where('id', 'in', input.ids)
    .where('status', '!=', input.status)
    .returning(['id', 'userId', 'alsoReportedBy'])
    .execute();
}

// A page of reports of one entity type, newest first, with reporter identity, the also-reported count, and
// the reported entity's id (both via correlated subqueries against the type's join table). Returns the page
// items plus the total for pagination.
export async function getReports(
  db: Kysely<DB>,
  { type, page = 1, limit = 20, statuses, reasons, reportedBy }: GetReportsParams
): Promise<{
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

  let base = db
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

// One report by id (whole row). Prisma took a caller-supplied `select`; the port returns the full row and
// lets the caller pick fields.
export function getReportById(db: Kysely<DB>, id: number) {
  return db.selectFrom('Report').selectAll().where('id', '=', id).executeTakeFirst();
}

// Reports by id (whole rows). Guards the empty list (Kysely compiles `in ([])` to a syntax error).
export async function getReportByIds(db: Kysely<DB>, ids: number[]) {
  if (!ids.length) return [];
  return db.selectFrom('Report').selectAll().where('id', 'in', ids).execute();
}

// Generic single-report update by id (Prisma `report.update`). Report has no `@updatedAt` column, so nothing
// to auto-stamp. jsonb `details`/other columns are the caller's responsibility to pre-wrap where needed.
export function updateReport(db: Kysely<DB>, input: Updateable<DB['Report']> & { id: number }) {
  const { id, ...data } = input;
  return db.updateTable('Report').set(data).where('id', '=', id).returningAll().executeTakeFirst();
}

// Transition every Report of a given reason attached to one image (UPDATE … FROM the ImageReport join), and
// RETURN the affected reports' id + reporter. Mirrors the raw `UPDATE "Report" r … FROM "ImageReport" i`.
export function updateImageReportStatusByReason(
  db: Kysely<DB>,
  input: { id: number; reason: ReportReasonValue; status: ReportStatusValue }
) {
  return db
    .updateTable('Report as r')
    .from('ImageReport as i')
    .set({ status: input.status })
    .whereRef('i.reportId', '=', 'r.id')
    .where('i.imageId', '=', input.id)
    .where('r.reason', '=', input.reason)
    .returning(['r.id', 'r.userId'])
    .execute();
}

// The Report insert core (Prisma `report.create` sans the nested join). Report has no `@updatedAt`;
// `createdAt`/`status`-adjacent columns default in the DB. jsonb `details` is bound via `toJson`; an undefined
// `details` is omitted so the column default (`{}`) applies, mirroring Prisma. RETURNs the created row.
export function insertReport(
  db: Kysely<DB>,
  input: {
    userId: number;
    reason: ReportReasonValue;
    status: ReportStatusValue;
    details?: unknown;
    internalNotes?: string | null;
  }
) {
  return db
    .insertInto('Report')
    .values({
      userId: input.userId,
      reason: input.reason,
      status: input.status,
      ...(input.details !== undefined ? { details: toJson(input.details) } : {}),
      ...(input.internalNotes !== undefined ? { internalNotes: input.internalNotes } : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// The per-type entity-join insert (`<Entity>Report`: `{ reportId, <x>Id }`) — the Prisma nested `[type].create`.
// The join table/column is one of 15 (dynamic), so this uses raw sql, as `getReports` does for the same reason.
export function insertReportEntity(
  db: Kysely<DB>,
  input: { type: ReportEntity; reportId: number; entityId: number }
) {
  const join = reportEntityJoin[input.type];
  return sql`insert into ${sql.table(join.table)} (${sql.ref('reportId')}, ${sql.ref(
    join.fk
  )}) values (${input.reportId}, ${input.entityId})`.execute(db);
}

// The ImageRatingRequest branch's write: upsert the (imageId,userId) rating request, bumping `nsfwLevel` on
// conflict. `weight` defaults to 3 (the app's value for report-derived requests). The moderated-tags lookup +
// maxRating computation that gate this in the app stay app-side (cache dependency, not pure DB).
export function upsertImageRatingRequest(
  db: Kysely<DB>,
  input: { imageId: number; userId: number; nsfwLevel: number; weight?: number }
) {
  return db
    .insertInto('ImageRatingRequest')
    .values({
      imageId: input.imageId,
      userId: input.userId,
      nsfwLevel: input.nsfwLevel,
      weight: input.weight ?? 3,
    })
    .onConflict((oc) =>
      oc.columns(['imageId', 'userId']).doUpdateSet({ nsfwLevel: input.nsfwLevel })
    )
    .execute();
}

export type CreateReportInput = {
  userId: number;
  type: ReportEntity;
  entityId: number;
  reason: ReportReasonValue;
  status: ReportStatusValue;
  details?: unknown;
  internalNotes?: string | null;
  // The ImageRatingRequest branch (NSFW image/model reports): when the caller has determined — via the
  // moderated-tags cache, which stays app-side — that the reported tags imply a higher rating than the image
  // currently has, it passes this so the same transaction upserts the rating request and unlocks the image.
  imageRating?: { imageId: number; userId: number; nsfwLevel: number; weight?: number };
};

// Insert a Report plus its per-type entity-join row in one transaction (the Prisma nested-create decomposed
// per the package's transaction convention), optionally running the ImageRatingRequest branch (upsert rating
// request + unlock the image). Side effects on other domains (tag votes, buzz, notifications, imageEngagement
// hide, the CSAM cascade, search-index sync) and the post-commit article-nsfw recompute are DROPPED — the
// caller owns those. Returns the created Report row.
export function createReport(db: Kysely<DB>, input: CreateReportInput) {
  return db.transaction().execute(async (trx) => {
    const report = await insertReport(trx, input);
    await insertReportEntity(trx, {
      type: input.type,
      reportId: report.id,
      entityId: input.entityId,
    });
    if (input.imageRating) {
      await upsertImageRatingRequest(trx, input.imageRating);
      await trx
        .updateTable('Image')
        .set({ nsfwLevelLocked: false })
        .where('id', '=', input.imageRating.imageId)
        .execute();
    }
    return report;
  });
}
