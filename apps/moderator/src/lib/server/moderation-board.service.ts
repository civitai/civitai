import { sql } from '@civitai/db/kysely';
import type { task_enum_0648e184 } from './moderator-db/enums';
import { dbRead } from './db';
import { getModeratorDb } from './moderator-db';
import { REPORT_ENTITIES } from './report-entities';

// Retool's Moderation Status board — the parts that are NOT counts.
//
// The dashboard already carries every count this page had. What it never carried is the comparison the
// counts sat inside: who last worked each queue and when, and how far behind each swept task is. A
// number alone cannot distinguish a queue nobody has touched in a week from one being actively drained,
// which is the judgement the board existed to support.

/** Who last resolved a report of each type (Retool's `RecentReports`, a 12-way UNION of LIMIT 1s). */
export type QueueActivity = { type: string; at: Date; moderator: string | null };

export async function getRecentQueueActivity(): Promise<Map<string, QueueActivity>> {
  // The join table is dynamic, so this is a raw `sql` tag rather than a builder join — the table name
  // comes from `REPORT_ENTITIES`, never from a request. `!= 'Pending'` rather than `= 'Actioned'`:
  // unactioning is also working the queue, and Retool counted it. `statusSetAt` is null on rows that
  // predate the column.
  const rows = await Promise.all(
    REPORT_ENTITIES.map(async ({ label, reportTable }) => {
      const { rows: found } = await sql<{ statusSetAt: Date; username: string | null }>`
        SELECT r."statusSetAt", u."username"
        FROM "Report" r
        JOIN ${sql.table(reportTable)} rt ON rt."reportId" = r."id"
        LEFT JOIN "User" u ON u."id" = r."statusSetBy"
        WHERE r."status" != 'Pending' AND r."statusSetAt" IS NOT NULL
        ORDER BY r."statusSetAt" DESC
        LIMIT 1
      `.execute(dbRead);

      const row = found[0];
      return row
        ? ([
            label,
            { type: `${label} reports`, at: row.statusSetAt, moderator: row.username },
          ] as const)
        : null;
    })
  );

  return new Map(rows.filter((r): r is NonNullable<typeof r> => r !== null));
}

/**
 * The other half of "who last worked what" — `ModActivity`, the log every queue in this app writes to.
 * `getRecentQueueActivity` above reads `Report` alone, so a queue that closes no report showed up
 * nowhere.
 *
 * Grouped by (entityType, activity) because that is the granularity the log carries. Do NOT put the
 * queue into the stored `activity` string to get finer rows — its values are a contract with the main
 * app, which writes and types them too.
 *
 * The window is a row count, not a date range: `ModActivity_createdAt_idx` makes it an index scan,
 * where `DISTINCT ON` over a fortnight would sort every row in it. It is large because the log is one
 * row PER ENTITY — a single bulk action can write thousands — and a window a burst can fill collapses
 * the panel to that one action, dropping exactly the least-recently-worked rows it exists to surface.
 */
const RECENT_ACTIVITY_ROWS = 20_000;

/** Automated writers use a sentinel id. They belong to the sweeps strip, not to a panel whose whole
 *  claim is which PERSON last touched a queue — a cron rendering as a nameless moderator is worse
 *  than its absence. */
const AUTOMATED_USER_ID = 0;

const MOD_ACTIVITY_LABELS: Record<string, string> = {
  review: 'reviews',
  setNsfwLevel: 'ratings',
  setNsfwLevelKono: 'ratings (KoNO)',
  resolveAppeal: 'appeals',
  ratingReview: 'rating disputes',
};

/** Membership is named, not inferred from the `:` — a colon is the separator every parameterised
 *  activity uses, so `buzz:send:yellow:…` read as a flag write too. */
const FLAG_ACTIVITIES = new Set(['minor', 'poi', 'spamWhitelist', 'deservedMute']);

/** Activities whose second segment is a verb rather than a value, a count or an id — `buzz:send` and
 *  `buzz:deduct` are two decisions and must not share a row. */
const DIRECTIONAL_ACTIVITIES = new Set(['buzz', 'comments', 'reviews']);

/** Anything unmapped is humanised rather than enumerated — the log gains values from the main app
 *  without passing through here. */
function modActivityLabel(entityType: string | null, activity: string): string {
  const entity = (entityType ?? 'other').replace(/^./, (c) => c.toUpperCase());
  const [name, second] = activity.split(':');
  const known = MOD_ACTIVITY_LABELS[activity];
  if (known) return `${entity} ${known}`;
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  if (FLAG_ACTIVITIES.has(name)) return `${entity} ${words} flags`;
  if (second && DIRECTIONAL_ACTIVITIES.has(name)) return `${entity} ${words} ${second}`;
  return `${entity} ${words}`;
}

export async function getRecentModActivity(): Promise<QueueActivity[]> {
  const rows = await dbRead
    .selectFrom('ModActivity as ma')
    .leftJoin('User as u', 'u.id', 'ma.userId')
    .select(['ma.entityType', 'ma.activity', 'ma.createdAt', 'u.username'])
    .where('ma.userId', '>', AUTOMATED_USER_ID)
    .orderBy('ma.createdAt', 'desc')
    .limit(RECENT_ACTIVITY_ROWS)
    .execute();

  const latest = new Map<string, QueueActivity>();
  for (const row of rows) {
    const type = modActivityLabel(row.entityType, row.activity);
    // Rows arrive newest-first, so the first sighting of a label is its most recent.
    if (!latest.has(type)) latest.set(type, { type, at: row.createdAt, moderator: row.username });
  }
  return [...latest.values()];
}

/**
 * How far behind each swept queue is (Retool's `MinorTimers`/`PoITimers`/`TagTimer`/… against
 * `Mods_TaskTimers`). Retool had one query per task; they differ only in the `task` literal.
 *
 * The row is an ACKNOWLEDGEMENT a moderator wrote, not a job run — see the table's type. So "3 days
 * ago" means nobody has claimed this queue in three days, which is the signal.
 */
export type TaskLag = {
  task: string;
  label: string;
  lastUpdate: Date;
  lastUpdateBy: string | null;
};

/**
 * `Mods_TaskTimers` also holds the front-page audit's per-level rows, whose `task` is a browsing-level
 * digit (`1`, `2`, `4`, `8`, `16`, and `<n>_catchup`). Printed raw under "when each queue was last
 * claimed" they read as nonsense; Retool never showed them raw either.
 */
const NSFW_LEVEL_NAMES: Record<string, string> = {
  '1': 'PG',
  '2': 'PG-13',
  '4': 'R',
  '8': 'X',
  '16': 'XXX',
};

function taskLabel(task: string): string {
  const [level, suffix] = task.split('_');
  const name = NSFW_LEVEL_NAMES[level];
  if (name) return suffix ? `Front page ${name} (catch-up)` : `Front page ${name}`;
  // The rest are already words (`minor`, `poi`, `articles`, `blockedImages`, …).
  return task.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

export async function getTaskLag(): Promise<TaskLag[]> {
  const rows = await getModeratorDb()
    .selectFrom('Mods_TaskTimers')
    .select((eb) => [
      'task',
      eb.fn.max('lastUpdate').as('lastUpdate'),
      // The name attached to the newest row, not an arbitrary one from the group.
      sql<string | null>`(array_agg("lastUpdateBy" ORDER BY "lastUpdate" DESC))[1]`.as(
        'lastUpdateBy'
      ),
    ])
    .where('task', 'is not', null)
    .groupBy('task')
    .execute();

  return rows
    .filter((r) => r.task && r.lastUpdate)
    .map((r) => ({
      task: r.task as string,
      label: taskLabel(r.task as string),
      lastUpdate: new Date(r.lastUpdate as unknown as string),
      lastUpdateBy: r.lastUpdateBy,
    }))
    .sort((a, b) => a.lastUpdate.getTime() - b.lastUpdate.getTime());
}

// SWEPT REVIEW COUNTS.
//
// Two queries the old audit filed as "backfill jobs" that are neither jobs nor backfills: each counts
// what has arrived in a queue SINCE the last acknowledgement, which is what makes them a workload
// rather than a total. Both read their bound from `Mods_TaskTimers`.
// `articles` and `bounties` are Retool's own task names, and both are LIVE — 2,028 and 1,213
// acknowledgements, the most recent written the same day the port was measured. So these are not new
// queues, they are two the port simply never rendered.
// Typed against the COLUMN's enum, so a typo here is a compile error rather than a Postgres error at
// the moment a moderator presses the button. `Mods_TaskTimers.task` accepts more values than these —
// this is the subset the board offers.
export const SWEEP_TASKS = [
  'blockedImages',
  'civitaiModels',
  'articles',
  'bounties',
] as const satisfies readonly task_enum_0648e184[];
export type SweepTask = (typeof SWEEP_TASKS)[number];

async function getSweepAt(task: SweepTask): Promise<Date | null> {
  const row = await getModeratorDb()
    .selectFrom('Mods_TaskTimers')
    .select('lastUpdate')
    .where('task', '=', task)
    .orderBy('lastUpdate', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.lastUpdate ? new Date(row.lastUpdate as unknown as string) : null;
}

/**
 * Retool's `BlockedImagesTask`: images blocked for an **unusual** reason since the last sweep. The four
 * excluded values are the ordinary ones — anything else means the blocker fired for a reason a
 * moderator has not seen, which is the case worth looking at.
 */
async function countBlockedImagesSince(since: Date): Promise<number> {
  const row = await dbRead
    .selectFrom('Image')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('ingestion', '=', 'Blocked')
    .where('blockedFor', 'not in', ['moderated', 'Moderated', 'CSAM', 'AiNotVerified'])
    .where('createdAt', '>', since)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/** Retool's `CivitModelsData`: what the official account (`userId = -1`) has published since the sweep. */
async function countCivitaiModelsSince(since: Date): Promise<number> {
  const row = await dbRead
    .selectFrom('Model')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('userId', '=', -1)
    .where('status', '=', 'Published')
    .where('updatedAt', '>', since)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/** Retool's `ArticleTimer` / `BountyTimer`: what has been published since the last sweep. `createdAt`
 *  rather than `publishedAt` because that is the column Retool bounded on, and the two differ for a
 *  draft that sat before publishing — matching it keeps the count comparable across the cutover. */
async function countSince(table: 'Article' | 'Bounty', since: Date): Promise<number> {
  const row = await dbRead
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('createdAt', '>', since)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export type SweepCount = { task: SweepTask; since: Date | null; count: number };

export async function getSweepCounts(): Promise<SweepCount[]> {
  const [blockedAt, civitaiAt, articlesAt, bountiesAt] = await Promise.all([
    getSweepAt('blockedImages'),
    getSweepAt('civitaiModels'),
    getSweepAt('articles'),
    getSweepAt('bounties'),
  ]);

  // No acknowledgement yet means no bound, and an unbounded count over all history is a different
  // question — reported as "never swept" rather than as a number nobody can act on.
  const [blocked, civitai, articles, bounties] = await Promise.all([
    blockedAt ? countBlockedImagesSince(blockedAt) : Promise.resolve(0),
    civitaiAt ? countCivitaiModelsSince(civitaiAt) : Promise.resolve(0),
    articlesAt ? countSince('Article', articlesAt) : Promise.resolve(0),
    bountiesAt ? countSince('Bounty', bountiesAt) : Promise.resolve(0),
  ]);

  return [
    { task: 'blockedImages', since: blockedAt, count: blocked },
    { task: 'civitaiModels', since: civitaiAt, count: civitai },
    { task: 'articles', since: articlesAt, count: articles },
    { task: 'bounties', since: bountiesAt, count: bounties },
  ];
}

/**
 * The other half of the protocol. Retool wrote this from every `*Insert`/`*Check` button; without a
 * writer the mark never advances and every "since last sweep" count grows forever — the same
 * consumer-with-no-producer trap the help-request queue had.
 */
export async function acknowledgeSweep(task: SweepTask, by: string): Promise<void> {
  await getModeratorDb()
    .insertInto('Mods_TaskTimers')
    .values({ task, lastUpdate: sql`now()`, lastUpdateBy: by })
    .execute();
}

/**
 * Retool's `AutoBlockedUsers` (`table10` on the board): accounts the scam detector muted on its own.
 * Nobody decided these individually, so the list is the only place they are reviewable — and a false
 * positive here is a muted account with no moderator behind it.
 */
export type AutoBlockedUser = {
  id: number;
  userId: number;
  username: string | null;
  createdAt: Date;
  bannedAt: Date | null;
  muted: boolean | null;
};

/**
 * Retool's `ActionAllPostReports`: pending post reports whose post is *entirely* blocked already
 * (`nsfwLevel = 32` on every image). The content has resolved the report; the row is only still open
 * because nobody clicked it.
 *
 * `HAVING COUNT(*) = COUNT(CASE WHEN nsfwLevel = 32 …)` is doing real work — a post with one blocked
 * image and nine live ones must NOT match, so this cannot be rewritten as a simple `WHERE`. Posts with
 * no images cannot match either, since the join drops them.
 */
export async function getResolvedPostReportIds(limit = 500): Promise<number[]> {
  const { rows } = await sql<{ report_id: number }>`
    WITH targets AS (
      SELECT r.id AS report_id, i."nsfwLevel"
      FROM "Report" r
      JOIN "PostReport" pr ON pr."reportId" = r.id
      JOIN "Image" i ON i."postId" = pr."postId"
      WHERE r.status = 'Pending'
    )
    SELECT report_id
    FROM targets
    GROUP BY report_id
    HAVING COUNT(*) = COUNT(CASE WHEN "nsfwLevel" = 32 THEN 1 END)
    LIMIT ${limit}
  `.execute(dbRead);
  return rows.map((r) => r.report_id);
}

export async function getAutoBlockedUsers(limit = 50): Promise<AutoBlockedUser[]> {
  return (
    dbRead
      .selectFrom('ModActivity as ma')
      .innerJoin('User as u', 'u.id', 'ma.entityId')
      .select([
        'ma.id',
        'ma.entityId as userId',
        'ma.createdAt',
        'u.username',
        'u.bannedAt',
        'u.muted',
      ])
      .where('ma.activity', '=', 'autoMuteScam')
      // Retool had no entityType filter and got away with it because the activity name is unique to
      // users; keeping it makes the (entityType, entityId, createdAt) index usable.
      .where('ma.entityType', '=', 'user')
      .orderBy('ma.createdAt', 'desc')
      .limit(limit)
      .execute() as Promise<AutoBlockedUser[]>
  );
}

// MODELS THE OWNER ASKED TO HAVE RE-REVIEWED. Asked for as a queue with the query below; the page that
// works them is the main app's `/moderator/models`, so what was missing is the count that says to go
// there.
//
// NOT in `sidebar-counts.service.ts`, which every navigation waits on. There is no index for this
// predicate — `Model_status_nsfw_idx` gets the status and then filters 43,222 rows on the jsonb to
// return 61, measured at **2.7s** — so it is fetched on its own and cached, the same reasoning that put
// `getMostReported` behind `/api/most-reported`. A partial index would fix it, but that is a hand-applied
// migration and a decision to make deliberately rather than as a side effect of adding a count.
const MODELS_REVIEW_TTL_MS = 60_000;
let modelsReviewCache: { at: number; value: Promise<number> } | null = null;

export function getModelsNeedingReview(now = Date.now()): Promise<number> {
  if (modelsReviewCache && now - modelsReviewCache.at < MODELS_REVIEW_TTL_MS)
    return modelsReviewCache.value;
  const value = dbRead
    .selectFrom('Model')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('status', '=', 'UnpublishedViolation')
    .where(sql<boolean>`meta->>'needsReview' = 'true'`)
    .executeTakeFirst()
    .then((row) => Number(row?.count ?? 0));
  modelsReviewCache = { at: now, value };
  value.catch(() => {
    if (modelsReviewCache?.value === value) modelsReviewCache = null;
  });
  return value;
}
