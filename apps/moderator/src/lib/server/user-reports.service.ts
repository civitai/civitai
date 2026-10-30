import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
// Shared with user-lookup.service.ts's counts — two copies meant adding an entity type to the counts
// and not the rows, so the section states a count it cannot show rows for.
import { OWNED_REPORT_ENTITIES, REPORT_ENTITIES, chatReportSubject } from './report-entities';
import type { ReportEntity } from '$lib/reports';

// Everything behind `/api/user-reports` — the ROWS behind the Reports section, where the page load
// carries only counts. Retool showed status, the reason, who set the status and a link to the content;
// a count alone cannot answer "was this actioned, and by whom".
//
// One file per endpoint is the rule for this page's services — see user-signals.service.ts.
//
// Retool ran these as one hand-written UNION ALL per entity type. Kept as parallel queries so a new
// entity type is a line in a list rather than a string edit, and so one slow table cannot stall the
// rest — the same shape `getReportedContent` already uses for the counts.

export type UserReportRow = {
  /** Report ids are unique across entity types, so the id alone keys the merged list. */
  id: number;
  createdAt: Date;
  reason: string;
  status: string;
  /** The enum, for anything that RESOLVES the row — urls, routes, filters. */
  type: ReportEntity;
  /** The human label, for display only. It is not a key: 'Review' / 'Comic' / '3D Model' do not
   *  lowercase to the enum, which is how they became dead links when they were used as one. */
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

const toRow = (
  r: Record<string, unknown>,
  type: ReportEntity,
  entityType: string
): UserReportRow => ({
  id: r.id as number,
  createdAt: r.createdAt as Date,
  reason: String(r.reason),
  status: String(r.status),
  type,
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

/** The joins and status/reason filters every report list shares. Inlining them is how `reasons` came to
 *  be honoured on one list and silently ignored on the others. */
const reportBase = ({ statuses, reasons }: ReportQueryOptions) =>
  dbRead
    .selectFrom('Report as r')
    .leftJoin('User as reporter', 'reporter.id', 'r.userId')
    .leftJoin('User as mod', 'mod.id', 'r.statusSetBy')
    .$if(!!statuses?.length, (qb) => qb.where(sql<boolean>`r."status"::text = any(${statuses})`))
    .$if(!!reasons?.length, (qb) => qb.where(sql<boolean>`r."reason"::text = any(${reasons})`));

export type ReportQueryOptions = {
  limit?: number;
  /** Empty means every status. One account's screenshot showed 803 rows, so a 50-row unfiltered list
   *  is not a view of anything. */
  statuses?: string[];
  /** Empty means every reason. `Automated` reports are ~99.9% of the corpus on a flagged account — 556
   *  on one dev account against 3 human ones — so a caller asking "who reported them" has to say so. */
  reasons?: string[];
};

/** Reports filed against content THIS user owns (Retool's ReportsReceived). */
export async function getReportsReceived(
  userId: number,
  { limit = 200, statuses, reasons }: ReportQueryOptions = {}
): Promise<UserReportRow[]> {
  const perType = await Promise.all(
    OWNED_REPORT_ENTITIES.map(async ({ type, label, table, reportTable, fk, ownerColumn }) => {
      const rows = await reportBase({ statuses, reasons })
        .innerJoin(`${reportTable} as rr` as 'ImageReport as rr', 'rr.reportId', 'r.id')
        .innerJoin(`${table} as e` as 'Image as e', 'e.id', `rr.${fk}` as 'rr.imageId')
        .select([...REPORT_COLUMNS, sql<number>`rr.${sql.ref(fk)}`.as('entityId')])
        .where(`e.${ownerColumn}` as 'e.userId', '=', userId)
        .orderBy('r.createdAt', 'desc')
        .limit(limit)
        .execute();
      return rows.map((r) => toRow(r as Record<string, unknown>, type, label));
    })
  );

  // Chat is out of the loop above because no column on `Chat` names who was reported; the rule lives in
  // `chatReportSubject`. Kept in the same list so these rows and the count tile cannot disagree.
  const chatRows = await reportBase({ statuses, reasons })
    .innerJoin('ChatReport as rr', 'rr.reportId', 'r.id')
    .innerJoin('Chat as e', 'e.id', 'rr.chatId')
    .select([...REPORT_COLUMNS, sql<number>`rr."chatId"`.as('entityId')])
    .where(chatReportSubject('e.id', 'r', userId))
    .orderBy('r.createdAt', 'desc')
    .limit(limit)
    .execute();

  return newestFirst(
    [
      ...perType.flat(),
      ...chatRows.map((r) => toRow(r as Record<string, unknown>, 'chat', 'Chat')),
    ],
    limit
  );
}

/** Reports THIS user filed (Retool's ReportsSubmitted). The entity is resolved the same way so a
 *  moderator can see what was reported, not just that something was. */
export async function getReportsSubmitted(
  userId: number,
  { limit = 200, statuses, reasons }: ReportQueryOptions = {}
): Promise<UserReportRow[]> {
  const perType = await Promise.all(
    // Every type, an ACCOUNT included — that is the commonest kind a user files, and omitting it made
    // the section's own total count rows it then refused to show.
    REPORT_ENTITIES.map(async ({ type, label, reportTable, fk }) => {
      const rows = await reportBase({ statuses, reasons })
        .innerJoin(`${reportTable} as rr` as 'ImageReport as rr', 'rr.reportId', 'r.id')
        .select([...REPORT_COLUMNS, sql<number>`rr.${sql.ref(fk)}`.as('entityId')])
        .where('r.userId', '=', userId)
        .orderBy('r.createdAt', 'desc')
        .limit(limit)
        .execute();
      return rows.map((r) => toRow(r as Record<string, unknown>, type, label));
    })
  );

  return newestFirst(perType.flat(), limit);
}

/** Reports filed against the ACCOUNT itself, not its content (Retool's ReportOnUser). Defaults to open
 *  ones — the question on arrival is what is outstanding against them right now. */
export async function getReportsOnUser(
  userId: number,
  { limit = 200, statuses = ['Pending', 'Processing'], reasons }: ReportQueryOptions = {}
): Promise<UserReportRow[]> {
  const rows = await reportBase({ statuses, reasons })
    .innerJoin('UserReport as ur', 'ur.reportId', 'r.id')
    .select([...REPORT_COLUMNS, sql<number | null>`ur."userId"`.as('entityId')])
    .where('ur.userId', '=', userId)
    .$if(!!reasons?.length, (qb) => qb.where(sql<boolean>`r."reason"::text = any(${reasons})`))
    .orderBy('r.createdAt', 'desc')
    .limit(limit)
    .execute();

  return rows.map((r) => toRow(r as Record<string, unknown>, 'reportedUser', 'User'));
}

const newestFirst = (rows: UserReportRow[], limit: number) =>
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
