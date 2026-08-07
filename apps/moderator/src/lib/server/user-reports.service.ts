import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';

// Everything behind `/api/user-reports` — the ROWS behind the Reports section, where the page load
// carries only counts. Retool showed status, the reason, who set the status and a link to the content;
// a count alone cannot answer "was this actioned, and by whom".
//
// One file per endpoint is the rule for this page's services — see user-signals.service.ts.
//
// Retool ran these as one hand-written UNION ALL per entity type. Kept as parallel queries so a new
// entity type is a line in a list rather than a string edit, and so one slow table cannot stall the
// rest — the same shape `getReportedContent` already uses for the counts.

const REPORT_SOURCES = [
  ['Image', 'Image', 'ImageReport', 'imageId'],
  ['Model', 'Model', 'ModelReport', 'modelId'],
  ['Post', 'Post', 'PostReport', 'postId'],
  ['Article', 'Article', 'ArticleReport', 'articleId'],
  ['Comment', 'Comment', 'CommentReport', 'commentId'],
  ['CommentV2', 'CommentV2', 'CommentV2Report', 'commentV2Id'],
] as const;

export type UserReportRow = {
  /** Report ids are unique across entity types, so the id alone keys the merged list. */
  id: number;
  createdAt: Date;
  reason: string;
  status: string;
  entityType: string;
  entityId: number | null;
  /** The reporter for a received report; the subject's content owner is implied by the query. */
  reporterId: number | null;
  reporter: string | null;
  statusSetBy: string | null;
  statusSetAt: Date | null;
  details: unknown;
  internalNotes: string | null;
  alsoReportedBy: number[] | null;
  previouslyReviewedCount: number | null;
};

const REPORT_COLUMNS = [
  'r.id',
  'r.createdAt',
  'r.reason',
  'r.status',
  'r.statusSetAt',
  'r.details',
  'r.internalNotes',
  'r.alsoReportedBy',
  'r.previouslyReviewedCount',
  'r.userId as reporterId',
  'reporter.username as reporter',
  'mod.username as statusSetBy',
] as const;

const toRow = (r: Record<string, unknown>, entityType: string): UserReportRow => ({
  id: r.id as number,
  createdAt: r.createdAt as Date,
  reason: String(r.reason),
  status: String(r.status),
  entityType,
  entityId: (r.entityId as number | null) ?? null,
  reporterId: (r.reporterId as number | null) ?? null,
  reporter: (r.reporter as string | null) ?? null,
  statusSetBy: (r.statusSetBy as string | null) ?? null,
  statusSetAt: (r.statusSetAt as Date | null) ?? null,
  details: r.details ?? null,
  internalNotes: (r.internalNotes as string | null) ?? null,
  alsoReportedBy: (r.alsoReportedBy as number[] | null) ?? null,
  previouslyReviewedCount: (r.previouslyReviewedCount as number | null) ?? null,
});

/** Reports filed against content THIS user owns (Retool's ReportsReceived). */
export async function getReportsReceived(userId: number, limit = 50): Promise<UserReportRow[]> {
  const perType = await Promise.all(
    REPORT_SOURCES.map(async ([label, table, reportTable, fk]) => {
      const rows = await dbRead
        .selectFrom('Report as r')
        .innerJoin(`${reportTable} as rr` as 'ImageReport as rr', 'rr.reportId', 'r.id')
        .innerJoin(`${table} as e` as 'Image as e', 'e.id', `rr.${fk}` as 'rr.imageId')
        .leftJoin('User as reporter', 'reporter.id', 'r.userId')
        .leftJoin('User as mod', 'mod.id', 'r.statusSetBy')
        .select([...REPORT_COLUMNS, sql<number>`rr.${sql.ref(fk)}`.as('entityId')])
        .where('e.userId', '=', userId)
        .orderBy('r.createdAt', 'desc')
        .limit(limit)
        .execute();
      return rows.map((r) => toRow(r as Record<string, unknown>, label));
    })
  );

  return perType
    .flat()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

/** Reports THIS user filed (Retool's ReportsSubmitted). The entity is resolved the same way so a
 *  moderator can see what was reported, not just that something was. */
export async function getReportsSubmitted(userId: number, limit = 50): Promise<UserReportRow[]> {
  const perType = await Promise.all(
    REPORT_SOURCES.map(async ([label, , reportTable, fk]) => {
      const rows = await dbRead
        .selectFrom('Report as r')
        .innerJoin(`${reportTable} as rr` as 'ImageReport as rr', 'rr.reportId', 'r.id')
        .leftJoin('User as reporter', 'reporter.id', 'r.userId')
        .leftJoin('User as mod', 'mod.id', 'r.statusSetBy')
        .select([...REPORT_COLUMNS, sql<number>`rr.${sql.ref(fk)}`.as('entityId')])
        .where('r.userId', '=', userId)
        .orderBy('r.createdAt', 'desc')
        .limit(limit)
        .execute();
      return rows.map((r) => toRow(r as Record<string, unknown>, label));
    })
  );

  return perType
    .flat()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

/** Reports filed against the ACCOUNT itself, not its content (Retool's ReportOnUser). Retool showed
 *  only open ones — a closed report on an account is history, and the question here is what is
 *  outstanding against them right now. */
export async function getReportsOnUser(userId: number, limit = 50): Promise<UserReportRow[]> {
  const rows = await dbRead
    .selectFrom('Report as r')
    .innerJoin('UserReport as ur', 'ur.reportId', 'r.id')
    .leftJoin('User as reporter', 'reporter.id', 'r.userId')
    .leftJoin('User as mod', 'mod.id', 'r.statusSetBy')
    .select([...REPORT_COLUMNS, sql<number | null>`ur."userId"`.as('entityId')])
    .where('ur.userId', '=', userId)
    .where('r.status', 'in', ['Pending', 'Processing'])
    .orderBy('r.createdAt', 'desc')
    .limit(limit)
    .execute();

  return rows.map((r) => toRow(r as Record<string, unknown>, 'User'));
}
