import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
import { recordModActivity } from './mod-activity';
import { REPORT_ENTITIES, reportEntity } from './report-entities';
import { rewardReportReporters } from './rewards';
import {
  DEFAULT_REPORT_REASONS,
  NEW_REPORT_STATUSES,
  ReportStatus,
  reportCountKey,
  reportEntities,
  type ReportEntity,
  type ReportReason,
} from '$lib/reports';

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
  statusSetAt: Date | null;
  statusSetByUsername: string | null;
  entityId: number | null;
  /** Site-relative path for report types whose entity has no page of its own. Only comments set it —
   *  see `commentContextUrl`. `null` everywhere else, where `entityUrl` already answers. */
  contextUrl: string | null;
};

/**
 * A comment has no standalone page: the site opens it through whatever it hangs off. So a comment
 * report rendered as unlinked text, and the only way to the words being reported was to search for
 * them. Resolved in SQL because the parent is a join away and the queue already pays for one.
 *
 * `commentV2` threads carry the parent as one of a dozen nullable columns, and a REPLY carries none of
 * them — its thread's parent is the comment above it — so the resolution falls back to `rootThreadId`
 * (6,429 of the 6,785 reported replies on the dev clone). `bountyEntryId` threads never carry the
 * `bountyId` the URL needs (248 of 248), hence the join. `highlight` is what scrolls to and marks the
 * comment once the page opens, and is the whole point of linking rather than landing on the entity.
 */
function commentContextUrl(type: ReportEntity, entityId: ReturnType<typeof sql<number | null>>) {
  if (type === 'comment')
    return sql<string | null>`(
      SELECT '/models/' || c."modelId" || '?dialog=commentThread&commentId=' ||
             coalesce(c."parentId", c.id) || '&highlight=' || c.id
      FROM "Comment" c WHERE c.id = ${entityId} AND c."modelId" IS NOT NULL
    )`;

  if (type === 'commentV2')
    return sql<string | null>`(
      SELECT CASE
        WHEN p."imageId"       IS NOT NULL THEN '/images/'   || p."imageId"
        WHEN p."postId"        IS NOT NULL THEN '/posts/'    || p."postId"
        WHEN p."articleId"     IS NOT NULL THEN '/articles/' || p."articleId"
        WHEN p."reviewId"      IS NOT NULL THEN '/reviews/'  || p."reviewId"
        WHEN p."bountyEntryId" IS NOT NULL THEN '/bounties/' || be."bountyId" || '/entries/' || p."bountyEntryId"
        WHEN p."bountyId"      IS NOT NULL THEN '/bounties/' || p."bountyId"
        WHEN p."challengeId"   IS NOT NULL THEN '/challenges/' || p."challengeId"
        WHEN p."modelId"       IS NOT NULL THEN '/models/'   || p."modelId"
        WHEN p."comicProjectId" IS NOT NULL THEN '/comics/'  || p."comicProjectId"
        WHEN p."model3dId"     IS NOT NULL THEN '/3d-models/' || p."model3dId"
        -- Threads with no parent column at all are the remainder (3,519 on the dev clone). They are
        -- orphaned rows, not a missing mapping: one carries 110 comments and no entity of any kind.
        ELSE NULL
      END || '?highlight=' || cv.id
      FROM "CommentV2" cv
      JOIN "Thread" t ON t.id = cv."threadId"
      -- A reply's own thread hangs off a comment; the entity is on the root.
      LEFT JOIN "Thread" root ON root.id = t."rootThreadId"
      JOIN LATERAL (SELECT * FROM "Thread" x WHERE x.id = CASE WHEN t."commentId" IS NULL THEN t.id ELSE coalesce(root.id, t.id) END) p ON true
      LEFT JOIN "BountyEntry" be ON be.id = p."bountyEntryId"
      WHERE cv.id = ${entityId}
    )`;

  return sql<string | null>`null::text`;
}

/** `'all'` must be said, not implied by omission. These were optional and silently skipped, which is
 *  how Chat Audit came to count every chat report in history under copy promising open ones only. */
export type GetReportsParams = {
  type: ReportEntity;
  page?: number;
  limit?: number;
  statuses: ReportStatus[] | 'all';
  reasons: ReportReason[] | 'all';
  reportedBy?: string;
  /** Filed-on range. `to` is exclusive, so a caller filtering to a single day passes the next day —
   *  a `<=` on a date would drop everything reported after midnight on it. */
  from?: Date;
  to?: Date;
};

export async function getReports({
  type,
  page = 1,
  limit = 20,
  statuses,
  reasons,
  reportedBy,
  from,
  to,
}: GetReportsParams): Promise<{
  items: ModeratorReportRow[];
  totalItems: number;
  page: number;
  limit: number;
}> {
  const join = reportEntity(type);
  const offset = (page - 1) * limit;

  // The join table/column is dynamic, so these two use raw `sql`; the rest of the query stays typed.
  const entityExists = sql<boolean>`exists (select 1 from ${sql.table(
    join.reportTable
  )} er where er."reportId" = "Report"."id")`;
  const entityId = sql<number | null>`(select er.${sql.ref(join.fk)} from ${sql.table(
    join.reportTable
  )} er where er."reportId" = "Report"."id" limit 1)`;

  let base = dbRead
    .selectFrom('Report')
    .leftJoin('User', 'User.id', 'Report.userId')
    // Who RESOLVED it, aliased so it does not collide with the reporter join above. Retool's report
    // table showed this column; without it a moderator cannot tell whether to re-open a closed report.
    .leftJoin('User as resolver', 'resolver.id', 'Report.statusSetBy')
    .where(entityExists);

  if (statuses !== 'all') base = base.where('Report.status', 'in', statuses);
  if (reasons !== 'all') base = base.where('Report.reason', 'in', reasons);
  if (reportedBy) base = base.where('User.username', 'ilike', `${reportedBy}%`);
  if (from) base = base.where('Report.createdAt', '>=', from);
  if (to) base = base.where('Report.createdAt', '<', to);

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
      'Report.statusSetAt',
      'resolver.username as statusSetByUsername',
    ])
    .select(
      sql<number>`coalesce(array_length("Report"."alsoReportedBy", 1), 0)`.as('alsoReportedByCount')
    )
    .select(entityId.as('entityId'))
    .select(commentContextUrl(type, entityId).as('contextUrl'))
    .orderBy('Report.id', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()) as ModeratorReportRow[];

  return { items, totalItems, page, limit };
}

// Who has been working a queue (Retool's ReportHistory), so two moderators do not action the same
// subject twice. Lives here rather than beside a page: it is keyed on nothing page-specific, and every
// report surface eventually wants it.
export type ReportHistoryRow = {
  id: number;
  statusSetAt: Date | null;
  status: ReportStatus;
  moderator: string | null;
  entityId: number | null;
};

export async function getReportHistory(
  type: ReportEntity,
  limit = 300
): Promise<{ items: ReportHistoryRow[]; truncated: boolean }> {
  const join = reportEntity(type);
  const entityId = sql<number | null>`(select er.${sql.ref(join.fk)} from ${sql.table(
    join.reportTable
  )} er where er."reportId" = "Report"."id" limit 1)`;

  const rows = (await dbRead
    .selectFrom('Report')
    // LEFT, not INNER: a report resolved by an account since deleted still belongs in the history —
    // dropping it makes the queue look less worked than it was.
    .leftJoin('User', 'User.id', 'Report.statusSetBy')
    .select(['Report.id', 'Report.statusSetAt', 'Report.status', 'User.username as moderator'])
    .select(entityId.as('entityId'))
    .where(
      sql<boolean>`exists (select 1 from ${sql.table(
        join.reportTable
      )} er where er."reportId" = "Report"."id")`
    )
    .where('Report.statusSetAt', 'is not', null)
    .orderBy('Report.statusSetAt', 'desc')
    .limit(limit + 1)
    .execute()) as ReportHistoryRow[];

  return { items: rows.slice(0, limit), truncated: rows.length > limit };
}

// NEW reports, not open ones — see NEW_REPORT_STATUSES. Every reason a human files counts: narrowing
// further to a hand-triaged set left pending NSFW, CSAM and StickerPlacement reports showing a zero
// badge. `Automated` is the one exclusion, and the queue page lands on the same set (its `reason`
// default is this list) so the badge and the list cannot disagree — see DEFAULT_REPORT_REASONS.
export async function getReportCounts(): Promise<Record<string, number>> {
  const statuses = sql.join(NEW_REPORT_STATUSES.map((s) => sql.lit(s)));
  const reasons = sql.join(DEFAULT_REPORT_REASONS.map((r) => sql.lit(r)));
  // One pass over Report (rides Report_open_reason_id_idx), then each report table joins the result —
  // per-branch joins back to Report seq-scanned it once per entity type.
  const open = sql`select "id" from "Report" where "status" in (${statuses}) and "reason" in (${reasons})`;
  const branches = REPORT_ENTITIES.map(
    ({ type, reportTable }) => sql`select ${sql.lit(type)} as type, count(*)::int as count
      from ${sql.table(reportTable)} er
      join open_reports o on o."id" = er."reportId"`
  );
  const { rows } = await sql<{
    type: string;
    count: number;
  }>`with open_reports as materialized (${open})
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
  // A stale tab or a forged id must not report success. The UPDATE is deliberately a no-op when the
  // report is ALREADY in the requested status (that guard protects the reward path), so "nothing
  // changed" and "no such report" have to be told apart before answering — otherwise a moderator gets
  // a green result and a ModActivity `review` row for a report they never touched.
  const exists = await dbWrite
    .selectFrom('Report')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!exists) return { ok: false as const, error: 'That report no longer exists. Reload.' };

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

  return { ok: true as const, changed: !!updated };
}

/**
 * Reports whether the row was there, rather than throwing. Zero rows here means the report was
 * deleted while the moderator was typing — a race, not an error on their part — and the caller has
 * to be able to tell the difference, because the right answer is to take the row off their screen
 * rather than to leave them staring at notes that were silently dropped.
 */
export async function updateReportNotes({
  id,
  internalNotes,
}: {
  id: number;
  internalNotes: string | null;
}): Promise<{ ok: true } | { ok: false; gone: true }> {
  const result = await dbWrite
    .updateTable('Report')
    .set({ internalNotes })
    .where('id', '=', id)
    .executeTakeFirst();

  return result.numUpdatedRows > 0n ? { ok: true } : { ok: false, gone: true };
}

export type MostReportedRow = {
  id: number;
  reason: ReportReason;
  createdAt: Date;
  reportCount: number;
  /** `other` only when the report has no row in ANY of the fifteen report tables. */
  entity: ReportEntity | 'other';
  entityId: number | null;
  /** Site-relative deep link for entities with no page of their own — see `commentContextUrl`. */
  contextUrl: string | null;
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
  // Raw sql throughout: `alsoReportedBy` is a Postgres array and the ordering key, and the fifteen
  // per-type id columns are generated from `reportEntityJoin` rather than written out.
  //
  // The +1 is the report's own filer: `alsoReportedBy` holds every reporter EXCEPT `Report.userId`,
  // which is how the main app counts them too. Without it the column read one short, `> 1` hid every
  // two-reporter item behind copy promising "more than one reporter", and the dashboard's
  // URGENT_REPORT_COUNT fired a reporter late. `array_length` is NULL on an empty array, not 0.
  //
  // The LIMIT is taken in a CTE and the seventeen subplans resolved OUTSIDE it. Postgres cannot project
  // through a Sort, so in one flat query the target list is evaluated below the ORDER BY — for every
  // pending report of the week, not the twenty kept.
  const reportCount = sql<number>`coalesce(array_length(t."alsoReportedBy", 1), 0) + 1`;
  const entityId = (type: ReportEntity) => {
    const join = reportEntity(type);
    return sql<number | null>`(SELECT er.${sql.ref(join.fk)} FROM ${sql.table(join.reportTable)} er
                WHERE er."reportId" = top.id LIMIT 1)`;
  };

  const { rows } = await sql<
    Record<ReportEntity, number | null> & {
      id: number;
      reason: ReportReason;
      createdAt: Date;
      reportCount: number;
      reportedByUsername: string | null;
      commentContext: string | null;
      commentV2Context: string | null;
    }
  >`
    WITH top AS (
      SELECT t.id, t.reason, t."createdAt", t."userId", ${reportCount} AS "reportCount"
      FROM "Report" t
      LEFT JOIN "ImageReport" ir ON ir."reportId" = t.id
      LEFT JOIN "Image" i ON i.id = ir."imageId"
      WHERE t.status = ${ReportStatus.Pending}::"ReportStatus"
        AND ${reportCount} > 1
        AND t."createdAt" > now() - interval '1 week'
        AND i."blockedFor" IS NULL
      ORDER BY "reportCount" DESC, t."createdAt" DESC
      LIMIT ${limit}
    )
    SELECT
      top.id, top.reason, top."createdAt", top."reportCount",
      u.username AS "reportedByUsername",
      ${sql.join(
        reportEntities.map((type) => sql`${entityId(type)} AS ${sql.ref(type)}`),
        sql`, `
      )},
      ${commentContextUrl('comment', entityId('comment'))} AS "commentContext",
      ${commentContextUrl('commentV2', entityId('commentV2'))} AS "commentV2Context"
    FROM top
    JOIN "User" u ON u.id = top."userId"
    ORDER BY top."reportCount" DESC, top."createdAt" DESC
  `.execute(dbRead);

  return rows.map((r) => {
    const entity = reportEntities.find((type) => r[type] != null);
    return {
      id: r.id,
      reason: r.reason,
      createdAt: r.createdAt,
      reportCount: Number(r.reportCount ?? 0),
      entity: entity ?? 'other',
      entityId: entity ? Number(r[entity]) : null,
      contextUrl:
        entity === 'comment'
          ? r.commentContext
          : entity === 'commentV2'
          ? r.commentV2Context
          : null,
      reportedByUsername: r.reportedByUsername,
    };
  });
}
