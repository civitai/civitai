import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import { URGENT_REPORT_COUNT } from '$lib/queue-thresholds';
import { dbRead, dbWrite } from './db';
import { getRedis } from './redis';
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
 * Where to send a moderator for a reported thing that has no page of its own.
 *
 * Six of the fifteen report types name something the site only reaches through a parent — a comment
 * through its thread, a bounty entry through its bounty — so `entityUrl` returns null for them and the
 * row rendered as dead grey text. That was most of a moderator's clicks on the reports surfaces: the
 * only way to the words being reported was to search for them.
 *
 * Resolved in SQL because every parent is a join away and the queue already pays for one.
 *
 * `commentV2` threads carry the parent as one of a dozen nullable columns, and a REPLY carries none of
 * them — its thread's parent is the comment above it — so the resolution falls back to `rootThreadId`
 * (6,429 of the 6,785 reported replies on the dev clone). `bountyEntryId` threads never carry the
 * `bountyId` the URL needs (248 of 248), hence the join. `highlight` is what scrolls to and marks the
 * comment once the page opens, and is the whole point of linking rather than landing on the entity.
 */
type ContextResolver = (
  entityId: ReturnType<typeof sql<number | null>>
) => ReturnType<typeof sql<string | null>>;

const CONTEXT_RESOLVERS: Partial<Record<ReportEntity, ContextResolver>> = {
  comment: (entityId) =>
    sql<string | null>`(
      SELECT '/models/' || c."modelId" || '?dialog=commentThread&commentId=' ||
             coalesce(c."parentId", c.id) || '&highlight=' || c.id
      FROM "Comment" c WHERE c.id = ${entityId} AND c."modelId" IS NOT NULL
    )`,

  commentV2: (entityId) =>
    sql<string | null>`(
      SELECT coalesce(CASE
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
        -- /comments/v2/:id is the main app resolving the thread itself, the only thing left that can
        -- find the comment — better than the dead text this used to render.
        ELSE NULL
      END || '?highlight=' || cv.id, '/comments/v2/' || cv.id)
      FROM "CommentV2" cv
      JOIN "Thread" t ON t.id = cv."threadId"
      -- A reply's own thread hangs off a comment; the entity is on the root.
      LEFT JOIN "Thread" root ON root.id = t."rootThreadId"
      JOIN LATERAL (SELECT * FROM "Thread" x WHERE x.id = CASE WHEN t."commentId" IS NULL THEN t.id ELSE coalesce(root.id, t.id) END) p ON true
      LEFT JOIN "BountyEntry" be ON be.id = p."bountyEntryId"
      WHERE cv.id = ${entityId}
    )`,

  // A bounty entry lives under its bounty, and the id is only on the entry's own row.
  bountyEntry: (entityId) =>
    sql<string | null>`(
      SELECT '/bounties/' || be."bountyId" || '/entries/' || be.id
      FROM "BountyEntry" be WHERE be.id = ${entityId}
    )`,

  // A 3D model's review is rendered on the model's page.
  model3dReview: (entityId) =>
    sql<string | null>`(
      SELECT '/3d-models/' || r."model3dId"
      FROM "Model3DReview" r WHERE r.id = ${entityId}
    )`,

  // The reported thing IS an account, and profiles are addressed by name rather than id.
  reportedUser: (entityId) =>
    sql<string | null>`(
      SELECT '/user/' || u.username FROM "User" u WHERE u.id = ${entityId} AND u.username IS NOT NULL
    )`,
};

/** The types `entityUrl` cannot answer for. Derived from the resolvers so a new one cannot be written
 *  and then left unselected by the queries that render links. */
export const CONTEXT_ENTITIES = Object.keys(CONTEXT_RESOLVERS) as ReportEntity[];

function reportContextUrl(type: ReportEntity, entityId: ReturnType<typeof sql<number | null>>) {
  return CONTEXT_RESOLVERS[type]?.(entityId) ?? sql<string | null>`null::text`;
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
  /** One report, by id. What makes a report REACHABLE from a page that only lists it: User Lookup shows
   *  a user's reports read-only, and without this the only route to the action was to open the entity's
   *  queue and page through it by eye. Applied on top of the other filters, not instead of them — the
   *  page widens them itself when the id would otherwise fall outside the default view. */
  reportId?: number;
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
  reportId,
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
  if (reportId) base = base.where('Report.id', '=', reportId);

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
    .select(reportContextUrl(type, entityId).as('contextUrl'))
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

  await syncResolvedMarker(id, status);

  // `updated` is set only when the row actually changed, so re-actioning an already-Actioned report never
  // double-rewards.
  if (status === ReportStatus.Actioned && updated) {
    const reporterIds = [updated.userId, ...(updated.alsoReportedBy ?? [])];
    await rewardReportReporters({ reportId: id, reporterIds, ip });
  }

  return { ok: true as const, changed: !!updated };
}

/**
 * A page's worth of decisions, applied as one gesture.
 *
 * Sequential rather than `Promise.all`: each decision rewards its reporters and writes a ModActivity
 * row, and firing twenty-five of those at once is a burst on the write pool for no gain a moderator
 * can perceive.
 *
 * Reports every outcome instead of the first failure. A moderator who staged twenty-five decisions and
 * gets back "that report no longer exists" has no way to tell which twenty-four landed.
 */
export async function setReportStatuses(
  decisions: { id: number; status: ReportStatus }[],
  { userId, ip }: { userId: number; ip?: string }
): Promise<{ changed: number; unchanged: number; failed: { id: number; error: string }[] }> {
  let changed = 0;
  let unchanged = 0;
  const failed: { id: number; error: string }[] = [];

  for (const { id, status } of decisions) {
    const result = await setReportStatus({ id, status, userId, ip });
    if (!result.ok) failed.push({ id, error: result.error });
    else if (result.changed) changed += 1;
    else unchanged += 1;
  }

  return { changed, unchanged, failed };
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
  /** The reporter's own free-form fields. The only thing left to judge an `other` row on. */
  details: unknown;
  /** `other` only when the report has no row in ANY of the fifteen report tables. */
  entity: ReportEntity | 'other';
  entityId: number | null;
  /** Site-relative deep link for entities with no page of their own — see `commentContextUrl`. */
  contextUrl: string | null;
  reportedByUsername: string | null;
};

// Content the community is piling reports onto — the signal moderators use to find the worst
// live content fast. Excludes images already blocked, since those are handled.
//
// 🔴 NOT cached, deliberately. A 60s snapshot of this list is what the mod team reported as actioned
// reports coming back: it is held per-server unless it is in Redis, and even in Redis a fill that
// started before an action writes its pre-action rows back after it. This is a list moderators WORK —
// ten rows at a time, deciding on each — so it has to answer for the database, not for a snapshot.
export async function getMostReported(params: MostReportedParams): Promise<MostReportedRow[]> {
  const rows = await fetchMostReported(params);
  if (!rows.length) return rows;

  // Even uncached, the read is a replica and the decision that just resolved these went to the
  // primary — so the reload right after a save is exactly when lag would hand them back.
  let resolved: (string | null)[] = [];
  try {
    resolved = await getRedis().hmGet(
      REDIS_KEYS.REPORT.RESOLVED_RECENT,
      rows.map((r) => String(r.id))
    );
  } catch (e) {
    // Fail open: an unfiltered list is the behaviour before this filter existed.
    console.error('[reports] resolved-report filter unavailable', e);
    return rows;
  }
  return rows.filter((_, i) => !resolved[i]);
}

/**
 * Outlives the snapshot TTL deliberately — a marker has to still be there when the last snapshot
 * written before the action finally expires.
 */
const RESOLVED_MARKER_TTL_SECONDS = 300;

/**
 * `/reports/[slug]` offers every status, Pending included, so a moderator can put a report back in
 * the queue. Marking that one resolved would hide a genuinely pending report for five minutes.
 */
async function syncResolvedMarker(id: number, status: ReportStatus): Promise<void> {
  try {
    const redis = getRedis();
    if (status === ReportStatus.Pending)
      await redis.hDel(REDIS_KEYS.REPORT.RESOLVED_RECENT, String(id));
    else
      await redis.hSetMultiWithExpire(
        REDIS_KEYS.REPORT.RESOLVED_RECENT,
        [String(id), '1'],
        RESOLVED_MARKER_TTL_SECONDS
      );
  } catch (e) {
    console.error('[reports] could not mark a report resolved for the dashboard', e);
  }
}

/**
 * The dashboard's twenty and the paginated page are the same query with a different window, so they
 * share it — two copies of a seventeen-subplan statement is how one of them comes to cover five entity
 * types.
 *
 * `days` is the age of the REPORT. The dashboard's week is what makes it a signal about now; the page
 * offers wider windows because a pile-up nobody worked does not stop mattering on day eight.
 */
export type MostReportedParams = { limit: number; offset?: number; days?: number };

/**
 * One page of the list, with the totals the surface needs around it.
 *
 * `urgent` is counted over the WHOLE window rather than the page: it is the incident signal, and a
 * banner that only counts what is on screen goes quiet the moment a moderator pages past the worst
 * ones — which is precisely when it should not.
 */
export async function getMostReportedPage({
  page = 1,
  limit = 10,
  days = 7,
}: {
  page?: number;
  limit?: number;
  days?: number;
}): Promise<{
  items: MostReportedRow[];
  totalItems: number;
  urgent: number;
  worst: number;
  page: number;
  limit: number;
}> {
  const [items, totals] = await Promise.all([
    getMostReported({ limit, offset: (page - 1) * limit, days }),
    countMostReported(days),
  ]);
  return { items, ...totals, page, limit };
}

/** The same predicate as the list, and nothing else — a count that drifts from its list puts a page
 *  number on a page that does not exist. Both totals come from one pass, since they differ only by a
 *  threshold on a column the row already carries. */
async function countMostReported(
  days: number
): Promise<{ totalItems: number; urgent: number; worst: number }> {
  const reportCount = sql<number>`coalesce(array_length(t."alsoReportedBy", 1), 0) + 1`;
  const { rows } = await sql<{ total: number; urgent: number; worst: number }>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE ${reportCount} >= ${URGENT_REPORT_COUNT})::int AS urgent,
           coalesce(max(${reportCount}), 0)::int AS worst
    FROM "Report" t
    LEFT JOIN "ImageReport" ir ON ir."reportId" = t.id
    LEFT JOIN "Image" i ON i.id = ir."imageId"
    WHERE t.status = ${ReportStatus.Pending}::"ReportStatus"
      AND ${reportCount} > 1
      AND t."createdAt" > now() - make_interval(days => ${days})
      AND i."blockedFor" IS NULL
  `.execute(dbRead);
  return {
    totalItems: Number(rows[0]?.total ?? 0),
    urgent: Number(rows[0]?.urgent ?? 0),
    // The banner names the worst pile-up, which is only on the page a moderator is looking at while
    // they are on page one.
    worst: Number(rows[0]?.worst ?? 0),
  };
}

async function fetchMostReported({
  limit,
  offset = 0,
  days = 7,
}: MostReportedParams): Promise<MostReportedRow[]> {
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
      details: unknown;
      reportedByUsername: string | null;
    } & Record<`context:${string}`, string | null>
  >`
    WITH top AS (
      SELECT t.id, t.reason, t."createdAt", t."userId", t.details, ${reportCount} AS "reportCount"
      FROM "Report" t
      LEFT JOIN "ImageReport" ir ON ir."reportId" = t.id
      LEFT JOIN "Image" i ON i.id = ir."imageId"
      WHERE t.status = ${ReportStatus.Pending}::"ReportStatus"
        AND ${reportCount} > 1
        AND t."createdAt" > now() - make_interval(days => ${days})
        AND i."blockedFor" IS NULL
      ORDER BY "reportCount" DESC, t."createdAt" DESC, t.id DESC
      LIMIT ${limit} OFFSET ${offset}
    )
    SELECT
      top.id, top.reason, top."createdAt", top."reportCount", top.details,
      u.username AS "reportedByUsername",
      ${sql.join(
        reportEntities.map((type) => sql`${entityId(type)} AS ${sql.ref(type)}`),
        sql`, `
      )},
      ${sql.join(
        CONTEXT_ENTITIES.map(
          (type) => sql`${reportContextUrl(type, entityId(type))} AS ${sql.ref(`context:${type}`)}`
        ),
        sql`, `
      )}
    FROM top
    JOIN "User" u ON u.id = top."userId"
    ORDER BY top."reportCount" DESC, top."createdAt" DESC, top.id DESC
  `.execute(dbRead);

  return rows.map((r) => {
    const entity = reportEntities.find((type) => r[type] != null);
    return {
      id: r.id,
      reason: r.reason,
      createdAt: r.createdAt,
      reportCount: Number(r.reportCount ?? 0),
      details: r.details,
      entity: entity ?? 'other',
      entityId: entity ? Number(r[entity]) : null,
      contextUrl: entity ? r[`context:${entity}`] ?? null : null,
      reportedByUsername: r.reportedByUsername,
    };
  });
}
