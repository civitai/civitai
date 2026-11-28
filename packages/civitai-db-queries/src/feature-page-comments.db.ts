import { CompiledQuery, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { csamHoldLockKey, csamQueueHeldText } from '@civitai/shared/held-url';

/**
 * The Feature Pages comment mirror's reads and writes. Every read is driven from
 * "FeaturePageCommentMirror" and joins "CommentV3" by primary key: an "entityType" equality on
 * "CommentV3" would scan the whole table.
 */

const rows = async <R>(db: Kysely<DB>, text: string, parameters: unknown[] = []) =>
  (await db.executeQuery<R>(CompiledQuery.raw(text, parameters))).rows;

/**
 * Whether the comment author `u` (a "User" alias, possibly from a LEFT JOIN) is in standing: there,
 * not deleted, banned or muted. False, never null, for a missing author.
 */
const fpAuthorInStanding = (u: string) =>
  `(${u}.id IS NOT NULL AND ${u}."deletedAt" IS NULL AND ${u}."bannedAt" IS NULL AND NOT ${u}.muted)`;

export type FpMirrorFactsRow = {
  commentId: number;
  userId: number;
  requestId: string;
  urn: string | null;
  goneCause: 'author' | 'moderator' | 'refused' | null;
  version: number;
  pushedState: string | null;
  pushedDigest: string | null;
  platformDigest: string | null;
  pendingDigest: string | null;
  pushAttempts: number;
  nextPushAt: Date | null;
  commentExists: boolean;
  hidden: boolean | null;
  tosViolation: boolean | null;
  deletedAt: Date | null;
  content: string | null;
  createdAt: Date | null;
  topicId: number | null;
  /** The comment it answers, if any; its urn is parentUrn once that one is on the platform. */
  parentId: number | null;
  subjectUrn: string | null;
  parentUrn: string | null;
  authorExists: boolean;
  authorDeletedAt: Date | null;
  authorInStanding: boolean;
  username: string | null;
  csamHeld: boolean;
  /**
   * The mirror row's own updatedAt when read: a record applies its schedule only if unchanged. As
   * text: a Date keeps milliseconds only, and the column holds microseconds.
   */
  mirrorUpdatedAt: string;
  postAttemptedAt: Date | null;
  subjectMissingAt: Date | null;
  removeWantedAt: Date | null;
  restrictedAt: Date | null;
  postSeq: number;
  goneAt: Date | null;
  /** The text's own event time (post or edit): the `at` a text post carries. */
  contentAt: Date | null;
  /** The current hide is the scan's own: a moderator hide sent now is sent for the scan. */
  scanHide: boolean;
  /** The `at` of the last moderator hide sent. */
  modHideSentAt: Date | null;
  /** Whose hide that was: 'foreign' (hidden there first by another) stays until shown again. */
  modHideOrigin: string | null;
  /** The text version a moderator lifted the scan's hide for. */
  liftGrantedVersion: number | null;
  /**
   * A moderator lifted the hide on this version after the last moderator hide sent, and that hide
   * was sent for the scan or a moderator here, never another's.
   */
  liftGranted: boolean;
};

/** SQL: the current hide of comment `c` is the scan's own (mirror row `m`). */
const FP_SCAN_HIDE = `COALESCE(c."hiddenAt" = m."scanHiddenAt" AND NOT c."tosViolation", false)`;

const FACTS = `
  SELECT m."commentId", m."userId", m."requestId", m.urn, m."goneCause", m.version, m."pushedState",
         m."pushedDigest", m."platformDigest", m."pendingDigest", m."pushAttempts", m."nextPushAt",
         m."updatedAt"::text AS "mirrorUpdatedAt", m."postAttemptedAt", m."subjectMissingAt",
         m."removeWantedAt", m."restrictedAt", m."postSeq", m."goneAt", m."contentAt",
         m."modHideSentAt", m."modHideOrigin", m."liftGrantedVersion",
         COALESCE(m."modHideOrigin" IN ('scan', 'moderator') AND m."liftGrantedAt" > m."modHideSentAt"
           AND m."liftGrantedVersion" = m.version, false) AS "liftGranted",
         ${FP_SCAN_HIDE} AS "scanHide",
         c.id IS NOT NULL AS "commentExists", c.hidden, c."tosViolation", c."deletedAt", c.content,
         c."createdAt", c."entityId" AS "topicId",
         COALESCE(c."replyToId", c."parentId") AS "parentId",
         t.urn AS "subjectUrn", pm.urn AS "parentUrn",
         u.id IS NOT NULL AS "authorExists", u."deletedAt" AS "authorDeletedAt",
         ${fpAuthorInStanding('u')} AS "authorInStanding", u.username,
         ${csamQueueHeldText('CommentV3', 'm."commentId"')} AS "csamHeld"
  FROM "FeaturePageCommentMirror" m
  LEFT JOIN "CommentV3" c ON c.id = m."commentId"
  LEFT JOIN "FeaturePageTopic" t ON t.id = c."entityId"
  LEFT JOIN "FeaturePageCommentMirror" pm ON pm."commentId" = COALESCE(c."replyToId", c."parentId")
  LEFT JOIN "User" u ON u.id = m."userId"`;

/** What "restrict" records: due now, first in the lease, and the alert clock started. */
export const FP_RESTRICT_SET = `"nextPushAt" = now(), "pushAttempts" = 0, "pendingDigest" = NULL,
  "restrictedAt" = COALESCE("restrictedAt", now()), "updatedAt" = now()`;

/** Whether this feature's migration has been applied here: the jobs run before it is. */
export async function fpMirrorTableExists(db: Kysely<DB>) {
  const [row] = await rows<{ present: boolean }>(
    db,
    `SELECT to_regclass('"FeaturePageCommentMirror"') IS NOT NULL AS present`
  );
  return !!row?.present;
}

/** One page of mirror rows that may still need a push (not erased, not refused), by comment id. */
export function readFpMirrorFactsPage(
  db: Kysely<DB>,
  { after, limit }: { after: number; limit: number }
) {
  return rows<FpMirrorFactsRow>(
    db,
    `${FACTS}
     WHERE m."commentId" > $1
       AND m."pushedState" IS DISTINCT FROM 'erased' AND m."pushedState" IS DISTINCT FROM 'refused'
     ORDER BY m."commentId"
     LIMIT $2`,
    [after, limit]
  );
}

export function readFpMirrorFacts(db: Kysely<DB>, commentIds: number[]) {
  if (!commentIds.length) return Promise.resolve([] as FpMirrorFactsRow[]);
  return rows<FpMirrorFactsRow>(
    db,
    `${FACTS} WHERE m."commentId" = ANY($1::int[]) ORDER BY m."commentId"`,
    [commentIds]
  );
}

/**
 * The dirty pass: due now, with the backoff reset, for what it should hold now (`pendingDigest`). A
 * restriction (`restrict`) also starts the alert clock.
 */
export async function markFpMirrorDue(
  db: Kysely<DB>,
  due: { commentId: number; pendingDigest: string; restrict: boolean }[]
) {
  if (!due.length) return;
  await rows(
    db,
    `UPDATE "FeaturePageCommentMirror" m
     SET "nextPushAt" = now(), "pushAttempts" = 0, "pendingDigest" = d.digest, "updatedAt" = now(),
         "restrictedAt" = CASE WHEN d.restrict THEN COALESCE(m."restrictedAt", now()) ELSE m."restrictedAt" END
     FROM unnest($1::int[], $2::text[], $3::boolean[]) AS d (id, digest, restrict)
     WHERE m."commentId" = d.id`,
    [due.map((d) => d.commentId), due.map((d) => d.pendingDigest), due.map((d) => d.restrict)]
  );
}

/**
 * Nothing restrictive is owed any more (a hold dismissed before anything was sent): stops the alert
 * clock on rows unchanged since they were read.
 */
export async function clearFpRestricted(
  db: Kysely<DB>,
  read: { commentId: number; readAt: string }[]
) {
  if (!read.length) return;
  await rows(
    db,
    `UPDATE "FeaturePageCommentMirror" m SET "restrictedAt" = NULL, "pendingDigest" = NULL
     FROM unnest($1::int[], $2::timestamptz[]) AS r (id, "readAt")
     WHERE m."commentId" = r.id AND m."updatedAt" = r."readAt"`,
    [read.map((r) => r.commentId), read.map((r) => r.readAt)]
  );
}

/**
 * Takes up to `limit` due rows for two minutes, owed restrictions first, then oldest first; returned
 * in that order. SKIP LOCKED and the lease keep two runs off the same row; nothing stays locked while
 * the pushes run.
 */
export async function leaseFpMirrorRows(db: Kysely<DB>, limit: number) {
  const leased = await rows<{ commentId: number; restricted: boolean; nextPushAt: Date }>(
    db,
    `WITH restricted AS (
       SELECT "commentId" FROM "FeaturePageCommentMirror"
       WHERE "restrictedAt" IS NOT NULL AND "nextPushAt" <= now()
         AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
       ORDER BY "nextPushAt"
       LIMIT $1
       FOR UPDATE SKIP LOCKED),
     rest AS (
       SELECT "commentId" FROM "FeaturePageCommentMirror"
       WHERE "nextPushAt" <= now() AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
         AND "commentId" NOT IN (SELECT "commentId" FROM restricted)
       ORDER BY "nextPushAt"
       LIMIT greatest($1 - (SELECT count(*) FROM restricted), 0)
       FOR UPDATE SKIP LOCKED)
     UPDATE "FeaturePageCommentMirror" SET "leaseUntil" = now() + interval '2 minutes'
     WHERE "commentId" IN (SELECT "commentId" FROM restricted UNION ALL SELECT "commentId" FROM rest)
     RETURNING "commentId", "restrictedAt" IS NOT NULL AS restricted, "nextPushAt"`,
    [limit]
  );
  return leased
    .sort(
      (a, b) =>
        Number(b.restricted) - Number(a.restricted) ||
        a.nextPushAt.getTime() - b.nextPushAt.getTime()
    )
    .map((r) => r.commentId);
}

/** Frees leases a run took and did not use, so those rows go out on the next run. */
export async function releaseFpLeases(db: Kysely<DB>, commentIds: number[]) {
  if (!commentIds.length) return;
  await rows(
    db,
    `UPDATE "FeaturePageCommentMirror" SET "leaseUntil" = NULL WHERE "commentId" = ANY($1::int[])`,
    [commentIds]
  );
}

export type FpPushRecord = {
  pushedState?: string;
  pushedDigest?: string | null;
  platformDigest?: string | null;
  urn?: string;
  postSeq?: number;
  /** null: nothing more to push until the dirty pass marks it again. */
  nextPushAt: Date | null;
  pushAttempts?: number;
  /** The row's updatedAt when it was read for this push. */
  readAt?: string;
  /** Parked rather than done: the dirty pass leaves it until what it should hold changes again. */
  parked?: boolean;
  /** A park's marker: the want (dirty-pass digest) the parked push was for. */
  parkedWant?: string;
  /** A park of a push that restricts: the restriction stays owed and timed. */
  parkedRestricting?: boolean;
  /** true: its feature subject is not on the platform yet (kept since first seen); false: clears it. */
  subjectMissing?: boolean;
  /** This send set postAttemptedAt and is known to have written nothing: clears it. */
  clearPostAttempted?: boolean;
  /** The platform holds a removal. */
  removeWanted?: boolean;
  /** A moderator hide was sent at this `at`, for the scan's hide or not. */
  modHide?: { at: Date; origin: 'scan' | 'moderator' | 'foreign' };
};

/**
 * Records one push outcome and frees the lease. What was pushed is always recorded. The schedule
 * (next push, attempts, and on success the pending digest and the restriction owed) is written only
 * if nothing changed the row since it was read; otherwise the row is due again at once with its
 * attempts reset.
 */
export async function recordFpPush(db: Kysely<DB>, commentId: number, r: FpPushRecord) {
  await rows(
    db,
    `UPDATE "FeaturePageCommentMirror" SET
       "pushedState" = COALESCE($2, "pushedState"),
       "pushedDigest" = CASE WHEN $3::boolean THEN $4 ELSE "pushedDigest" END,
       "platformDigest" = CASE WHEN $5::boolean THEN $6 ELSE "platformDigest" END,
       urn = COALESCE($7, urn),
       "postSeq" = COALESCE($10, "postSeq"),
       "nextPushAt" = CASE WHEN $11::timestamptz IS NULL OR "updatedAt" = $11 THEN $8 ELSE now() END,
       "pushAttempts" = CASE WHEN $11::timestamptz IS NULL OR "updatedAt" = $11
         THEN COALESCE($9, "pushAttempts") ELSE 0 END,
       "pendingDigest" = CASE WHEN ($11::timestamptz IS NULL OR "updatedAt" = $11) AND $8 IS NULL
         THEN CASE WHEN $12::boolean THEN COALESCE($16::text, "pendingDigest") END
         ELSE "pendingDigest" END,
       "restrictedAt" = CASE WHEN ($11::timestamptz IS NULL OR "updatedAt" = $11) AND $8 IS NULL
         AND NOT ($12::boolean AND $17::boolean) THEN NULL ELSE "restrictedAt" END,
       "subjectMissingAt" = CASE WHEN $13::boolean IS NULL THEN "subjectMissingAt"
         WHEN $13 THEN COALESCE("subjectMissingAt", now()) END,
       "postAttemptedAt" = CASE WHEN $14::boolean THEN NULL ELSE "postAttemptedAt" END,
       "removeWantedAt" = CASE WHEN $15::boolean THEN COALESCE("removeWantedAt", now())
         ELSE "removeWantedAt" END,
       "modHideSentAt" = COALESCE($18::timestamptz, "modHideSentAt"),
       "modHideOrigin" = CASE WHEN $18::timestamptz IS NULL THEN "modHideOrigin" ELSE $19 END,
       "leaseUntil" = NULL,
       "updatedAt" = now()
     WHERE "commentId" = $1`,
    [
      commentId,
      r.pushedState ?? null,
      r.pushedDigest !== undefined,
      r.pushedDigest ?? null,
      r.platformDigest !== undefined,
      r.platformDigest ?? null,
      r.urn ?? null,
      r.nextPushAt,
      r.pushAttempts ?? null,
      r.postSeq ?? null,
      r.readAt ?? null,
      !!r.parked,
      r.subjectMissing ?? null,
      !!r.clearPostAttempted,
      !!r.removeWanted,
      r.parkedWant ?? null,
      !!r.parkedRestricting,
      r.modHide?.at ?? null,
      r.modHide?.origin ?? null,
    ]
  );
}

/** The post path's own lease on its new row, so the cron does not push it at the same time. */
export async function leaseFpMirrorRow(db: Kysely<DB>, commentId: number) {
  const leased = await rows<{ commentId: number }>(
    db,
    `UPDATE "FeaturePageCommentMirror" SET "leaseUntil" = now() + interval '2 minutes'
     WHERE "commentId" = $1 AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
     RETURNING "commentId"`,
    [commentId]
  );
  return leased.length > 0;
}

/** Marks the first post as sent before it goes; leaves updatedAt, so the push's record still applies. */
export async function markFpPostAttempted(db: Kysely<DB>, commentId: number) {
  await rows(
    db,
    `UPDATE "FeaturePageCommentMirror" SET "postAttemptedAt" = COALESCE("postAttemptedAt", now())
     WHERE "commentId" = $1`,
    [commentId]
  );
}

/**
 * Records a removal as wanted before it is first sent, so a lost reply or a crash cannot let civitai
 * show the comment again. Leaves updatedAt, like markFpPostAttempted.
 */
export async function markFpRemoveWanted(db: Kysely<DB>, commentId: number) {
  await rows(
    db,
    `UPDATE "FeaturePageCommentMirror" SET "removeWantedAt" = COALESCE("removeWantedAt", now())
     WHERE "commentId" = $1`,
    [commentId]
  );
}

/** After author.erase@1: every row of that author is erased on the platform, leased or not. */
export async function markFpAuthorErased(db: Kysely<DB>, userId: number) {
  await rows(
    db,
    `UPDATE "FeaturePageCommentMirror"
     SET "pushedState" = 'erased', "nextPushAt" = NULL, "leaseUntil" = NULL, "restrictedAt" = NULL,
         "updatedAt" = now()
     WHERE "userId" = $1`,
    [userId]
  );
}

type ScanCandidate = {
  commentId: number;
  scanStatus: string | null;
  scanContentHash: string | null;
  scanAttempts: number;
  scanHash: string | null;
  /** Older than the alert window: an unscanned one of these is what the alert counts. */
  overdue: boolean;
};

/**
 * Live rows old enough that their scan should have landed: every one with no settled verdict, then
 * settled ones by comment id after `after`, so each is rechecked in turn. The attempt cap is the
 * caller's.
 */
export function readFpScanCandidates(
  db: Kysely<DB>,
  {
    olderThanMinutes,
    alertMinutes,
    limit,
    after,
  }: { olderThanMinutes: number; alertMinutes: number; limit: number; after: number }
) {
  return rows<ScanCandidate & { settled: boolean }>(
    db,
    `WITH live AS (
       SELECT m."commentId", em.status::text AS "scanStatus", em."contentHash" AS "scanContentHash",
              m."scanAttempts", m."scanHash", em.status IS NOT DISTINCT FROM 'Succeeded' AS settled,
              c."updatedAt" < now() - make_interval(mins => ${Math.trunc(alertMinutes)}) AS overdue
       FROM "FeaturePageCommentMirror" m
       JOIN "CommentV3" c ON c.id = m."commentId"
       LEFT JOIN "EntityModeration" em ON em."entityType" = 'CommentV3' AND em."entityId" = m."commentId"
       WHERE c."deletedAt" IS NULL
         AND c."updatedAt" < now() - make_interval(mins => ${Math.trunc(olderThanMinutes)})
         AND m."goneCause" IS NULL),
     unsettled AS (SELECT * FROM live WHERE NOT settled ORDER BY "commentId" LIMIT $1)
     SELECT * FROM unsettled
     UNION ALL
     (SELECT * FROM live WHERE settled AND "commentId" > $2 ORDER BY "commentId"
      LIMIT greatest($1 - (SELECT count(*) FROM unsettled), 0))`,
    [limit, after]
  );
}

/** Counts a re-queued scan against the hash it was for; a new hash starts the count again. */
export async function recordFpScanAttempt(db: Kysely<DB>, commentId: number, hash: string) {
  await rows(
    db,
    `UPDATE "FeaturePageCommentMirror" SET
       "scanAttempts" = CASE WHEN "scanHash" IS DISTINCT FROM $2 THEN 1 ELSE "scanAttempts" + 1 END,
       "scanHash" = $2, "updatedAt" = now()
     WHERE "commentId" = $1`,
    [commentId, hash]
  );
}

/** The mirror row a frame request already wrote, if any. */
export async function readFpMirrorByRequest(db: Kysely<DB>, userId: number, requestId: string) {
  const [row] = await rows<{ commentId: number; urn: string | null; pushedState: string | null }>(
    db,
    `SELECT "commentId", urn, "pushedState" FROM "FeaturePageCommentMirror"
     WHERE "userId" = $1 AND "requestId" = $2`,
    [userId, requestId]
  );
  return row;
}

/** The mirror rows the sweep reports on: overdue pushes, owed restrictions, stuck rows. */
export async function countFpOverduePushes(db: Kysely<DB>, minutes: number) {
  const [row] = await rows<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM "FeaturePageCommentMirror"
     WHERE "nextPushAt" < now() - make_interval(mins => ${Math.trunc(minutes)})`
  );
  return row?.n ?? 0;
}

/** Restrictions owed longer than `minutes`, whatever holds them up (failing, braked, no urn). */
export async function countFpOverdueRestrictions(db: Kysely<DB>, minutes: number) {
  const [row] = await rows<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM "FeaturePageCommentMirror"
     WHERE "restrictedAt" < now() - make_interval(mins => ${Math.trunc(minutes)})`
  );
  return row?.n ?? 0;
}

export async function countFpStuckRows(db: Kysely<DB>, maxAttempts: number) {
  const [row] = await rows<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM "FeaturePageCommentMirror"
     WHERE "pushAttempts" >= $1 AND "subjectMissingAt" IS NULL`,
    [maxAttempts]
  );
  return row?.n ?? 0;
}

/** Posts waiting on a feature subject the platform does not hold yet, and the oldest wait. */
export async function countFpSubjectWaits(db: Kysely<DB>) {
  const [row] = await rows<{ n: number; oldestMinutes: number | null }>(
    db,
    `SELECT count(*)::int AS n,
            (extract(epoch FROM now() - min("subjectMissingAt")) / 60)::int AS "oldestMinutes"
     FROM "FeaturePageCommentMirror" WHERE "subjectMissingAt" IS NOT NULL`
  );
  return { waiting: row?.n ?? 0, oldestMinutes: row?.oldestMinutes ?? 0 };
}

/** The comment's scan verdict as stored: its status, the text it was for, and whether it flagged. */
export async function readFpScanVerdict(db: Kysely<DB>, commentId: number) {
  const [row] = await rows<{ status: string; contentHash: string | null; flagged: boolean }>(
    db,
    `SELECT status::text AS status, "contentHash",
            coalesce(cardinality("triggeredLabels"), 0) > 0 AS flagged
     FROM "EntityModeration" WHERE "entityType" = 'CommentV3' AND "entityId" = $1`,
    [commentId]
  );
  return row;
}

/** By urn, for the reconcile. */
export function readFpMirrorByUrns(db: Kysely<DB>, urns: string[]) {
  if (!urns.length) return Promise.resolve([]);
  return rows<{ commentId: number; userId: number; urn: string; goneCause: string | null }>(
    db,
    `SELECT "commentId", "userId", urn, "goneCause"
     FROM "FeaturePageCommentMirror" WHERE urn = ANY($1::text[])`,
    [urns]
  );
}

export type FpReconcileAction = 'restrict' | 'removeWanted' | 'due' | 'repost' | 'stuck';

/**
 * A reconcile mismatch, on a row not already due: owe the restriction again, record the removal the
 * platform holds, push again (`repost`: the text too), or count it in the stuck alert (`stuck`, at
 * `maxAttempts`). Writes no belief about the platform. False when the row was already due.
 */
export async function markFpReconciled(
  db: Kysely<DB>,
  commentId: number,
  action: FpReconcileAction,
  maxAttempts = 0
) {
  const set = {
    restrict: FP_RESTRICT_SET,
    removeWanted: `"removeWantedAt" = COALESCE("removeWantedAt", now()), "updatedAt" = now()`,
    due: `"nextPushAt" = now(), "pushAttempts" = 0, "updatedAt" = now()`,
    repost: `"pushedDigest" = NULL, "nextPushAt" = now(), "pushAttempts" = 0, "updatedAt" = now()`,
    stuck: `"pushAttempts" = GREATEST("pushAttempts", $2::int), "updatedAt" = now()`,
  }[action];
  const updated = await rows(
    db,
    `UPDATE "FeaturePageCommentMirror" SET ${set} WHERE "commentId" = $1 AND "nextPushAt" IS NULL
     RETURNING "commentId"`,
    action === 'stuck' ? [commentId, maxAttempts] : [commentId]
  );
  return updated.length > 0;
}

/**
 * The runbook's first step, in one statement before any send: every row not erased or refused owes
 * a removal. Returns the rows the platform may hold text for.
 */
export async function markFpRunbookRemoval(db: Kysely<DB>) {
  return rows<{ commentId: number; reachable: boolean }>(
    db,
    `UPDATE "FeaturePageCommentMirror" SET "removeWantedAt" = COALESCE("removeWantedAt", now()), ${FP_RESTRICT_SET}
     WHERE "pushedState" IS DISTINCT FROM 'erased' AND "pushedState" IS DISTINCT FROM 'refused'
       AND "goneCause" IS DISTINCT FROM 'refused'
     RETURNING "commentId", urn IS NOT NULL AS reachable`
  );
}

/** For the runbook: leased rows, rows with a urn, and rows it cannot reach yet (sent, never answered). */
export async function readFpRunbookCounts(db: Kysely<DB>) {
  const [counts] = await rows<{ leased: number; unreachable: number; targets: number }>(
    db,
    `SELECT count(*) FILTER (WHERE "leaseUntil" > now())::int AS leased,
            count(*) FILTER (WHERE urn IS NOT NULL AND "pushedState" IS DISTINCT FROM 'erased'
              AND "pushedState" IS DISTINCT FROM 'refused')::int AS targets,
            count(*) FILTER (WHERE urn IS NULL AND "postAttemptedAt" IS NOT NULL
              AND "pushedState" IS DISTINCT FROM 'erased'
              AND "pushedState" IS DISTINCT FROM 'refused')::int AS unreachable
     FROM "FeaturePageCommentMirror"`
  );
  return {
    leased: counts?.leased ?? 0,
    unreachable: counts?.unreachable ?? 0,
    targets: counts?.targets ?? 0,
  };
}

/**
 * SQL predicate: an open report on the comment id expression `comment` from anyone but the user id
 * expression `system`, other than the report id expression `except`.
 */
const openPersonReport = (comment: string, system: string, except = 'NULL') => `EXISTS (
  SELECT 1 FROM "CommentV3Report" pcr JOIN "Report" pr ON pr.id = pcr."reportId"
  WHERE pcr."commentId" = ${comment} AND pr.status IN ('Pending', 'Processing')
    AND pr."userId" <> ${system} AND pr.id IS DISTINCT FROM ${except})`;

/** Whether anyone but the system user still has an open report on this comment. */
export async function hasOpenPersonFpReport(
  db: Kysely<DB>,
  { commentId, systemUserId }: { commentId: number; systemUserId: number }
) {
  const [row] = await rows<{ open: boolean }>(
    db,
    `SELECT ${openPersonReport('$1', '$2')} AS open`,
    [commentId, systemUserId]
  );
  return !!row?.open;
}

/** The details.comment of the report the scan files when it hides a Feature Pages comment. */
export const FP_AUTO_HIDE_REPORT_COMMENT = 'auto-hidden by scan';

/**
 * Takes, in the order an edit takes them, the hold decision's lock, the comment and its mirror row,
 * each in a statement of its own, so what is read after sees what any writer it waited on committed.
 */
async function lockFpCommentForLift(trx: Kysely<DB>, commentId: number) {
  await rows(trx, `SELECT pg_advisory_xact_lock(hashtext($2), $1::int)`, [
    commentId,
    csamHoldLockKey('CommentV3'),
  ]);
  await rows(trx, `SELECT id FROM "CommentV3" WHERE id = $1 FOR UPDATE`, [commentId]);
  await rows(trx, `SELECT 1 FROM "FeaturePageCommentMirror" WHERE "commentId" = $1 FOR UPDATE`, [
    commentId,
  ]);
}

/**
 * SQL select columns: what holds any lift of a hide on mirror row `m` (comment author `u`) now. The
 * system user is `system`; an open report `except` does not hold it.
 */
const fpLiftHolds = (system: string, except = 'NULL') => `
  COALESCE(m."modHideOrigin" = 'foreign', false) AS foreign,
  ${openPersonReport('m."commentId"', system, except)} AS reported,
  COALESCE(m."leaseUntil" > now(), false) AS pushing,
  NOT ${fpAuthorInStanding('u')} AS author,
  ${csamQueueHeldText('CommentV3', 'm."commentId"')} AS held`;

/** The order lift holds are named in when several apply. */
const FP_LIFT_HOLDS = ['foreign', 'reported', 'pushing', 'author', 'held'] as const;

/** SQL SET: a lift granted at `at` by `by` for text version `version`, due for a push now. */
const fpLiftGrantSet = (at: string, by: string, version: string) =>
  `"liftGrantedAt" = ${at}, "liftGrantedBy" = ${by}, "liftGrantedVersion" = ${version},
   "nextPushAt" = now(), "pushAttempts" = 0, "pendingDigest" = NULL, "updatedAt" = now()`;

/**
 * A moderator sets one report Unactioned. When it is the report the scan filed with its current hide
 * and it moves from open to Unactioned here, it also lifts that hide, in the same transaction.
 * `changed`: the status moved; `lifted`: the comment shown again, or null. `held`: that report is
 * left open, unchanged, because the lift cannot be made now, and why. `superseded`: it was the
 * scan's report, but its hide has since been replaced (another hide, or the comment removed).
 */
export async function unactionReportLiftingScanHide(
  db: Kysely<DB>,
  { reportId, actorId, systemUserId }: { reportId: number; actorId: number; systemUserId: number }
) {
  return db.transaction().execute(async (trx) => {
    const [link] = await rows<{ commentId: number }>(
      trx,
      `SELECT "commentId" FROM "CommentV3Report" WHERE "reportId" = $1`,
      [reportId]
    );
    const commentId = link?.commentId;
    // The report after the comment's locks, as an edit takes them.
    if (commentId !== undefined) await lockFpCommentForLift(trx, commentId);
    const [prior] = await rows<{ status: string }>(
      trx,
      `SELECT status::text AS status FROM "Report" WHERE id = $1 FOR UPDATE`,
      [reportId]
    );
    if (!prior || prior.status === 'Unactioned') return { changed: false, lifted: null };
    const opened = prior.status === 'Pending' || prior.status === 'Processing';
    // The scan's own report whose hide something else has since replaced: closed, and said so.
    let superseded: 'removed' | 'hidden' | undefined;
    if (commentId !== undefined && opened && actorId !== systemUserId) {
      // The scan's own report on the scan's current hide: a lift it cannot make now leaves it open
      // and says why, so the hide is never left with nobody told.
      const [wait] = await rows<{
        foreign: boolean;
        reported: boolean;
        pushing: boolean;
        author: boolean;
        held: boolean;
        version: boolean;
      }>(
        trx,
        `SELECT ${fpLiftHolds('$2')},
           m."scanHiddenVersion" IS DISTINCT FROM m.version AS version
         FROM "FeaturePageCommentMirror" m
         JOIN "CommentV3" c ON c.id = m."commentId"
         JOIN "Report" r ON r.id = m."scanHideReportId"
         LEFT JOIN "User" u ON u.id = c."userId"
         WHERE m."commentId" = $1 AND m."scanHideReportId" = $3
           AND r."userId" = $2 AND r.reason = 'AdminAttention' AND r.details->>'comment' = $4
           AND c."deletedAt" IS NULL AND c.hidden AND NOT c."tosViolation"
           AND c."hiddenAt" = m."scanHiddenAt" AND m."goneCause" IS NULL
           AND m."removeWantedAt" IS NULL`,
        [commentId, systemUserId, reportId, FP_AUTO_HIDE_REPORT_COMMENT]
      );
      const held = ([...FP_LIFT_HOLDS, 'version'] as const).find((why) => wait?.[why]);
      if (held) return { changed: false, lifted: null, held };
      if (!wait) {
        const [bound] = await rows<{ removed: boolean }>(
          trx,
          `SELECT (c.id IS NULL OR c."deletedAt" IS NOT NULL OR m."goneCause" IS NOT NULL
             OR m."removeWantedAt" IS NOT NULL) AS removed
           FROM "FeaturePageCommentMirror" m
           JOIN "Report" r ON r.id = m."scanHideReportId"
           LEFT JOIN "CommentV3" c ON c.id = m."commentId"
           WHERE m."commentId" = $1 AND m."scanHideReportId" = $3
             AND r."userId" = $2 AND r.reason = 'AdminAttention' AND r.details->>'comment' = $4`,
          [commentId, systemUserId, reportId, FP_AUTO_HIDE_REPORT_COMMENT]
        );
        if (bound) superseded = bound.removed ? 'removed' : 'hidden';
      }
    }
    await rows(
      trx,
      `UPDATE "Report" SET status = 'Unactioned', "statusSetAt" = now(), "statusSetBy" = $2
       WHERE id = $1`,
      [reportId, actorId]
    );
    if (commentId === undefined || !opened || actorId === systemUserId || superseded)
      return { changed: true, lifted: null, superseded };
    // A push may send the scan's hide again after the lift, and the platform keeps it, so the lease
    // and person-report conditions repeat the checks above.
    const [lifted] = await rows<{ commentId: number; version: number }>(
      trx,
      `WITH ok AS (
         SELECT m."commentId", m.version FROM "FeaturePageCommentMirror" m
         JOIN "CommentV3" c ON c.id = m."commentId"
         JOIN "User" u ON u.id = c."userId"
         JOIN "Report" r ON r.id = $4
         WHERE m."commentId" = $1 AND c."entityType"::text = 'featurePage'
           AND m."scanHideReportId" = r.id AND r."userId" = $3 AND r.reason = 'AdminAttention'
           AND r.details->>'comment' = $5
           AND c."deletedAt" IS NULL AND c.hidden AND NOT c."tosViolation"
           AND c."hiddenAt" = m."scanHiddenAt" AND m."scanHiddenVersion" = m.version
           AND m."goneCause" IS NULL AND m."removeWantedAt" IS NULL
           AND m."modHideOrigin" IS DISTINCT FROM 'foreign'
           AND (m."leaseUntil" IS NULL OR m."leaseUntil" < now())
           AND ${fpAuthorInStanding('u')}
           AND NOT ${csamQueueHeldText('CommentV3', 'm."commentId"')}
           AND NOT ${openPersonReport('m."commentId"', '$3')}
       ), shown AS (
         UPDATE "CommentV3" SET hidden = false, "hiddenAt" = NULL, "updatedAt" = now()
         WHERE id = (SELECT "commentId" FROM ok)
         RETURNING id
       )
       UPDATE "FeaturePageCommentMirror" m SET ${fpLiftGrantSet(
         'clock_timestamp()',
         '$2',
         'ok.version'
       )}
       FROM ok, shown WHERE m."commentId" = ok."commentId" AND shown.id = ok."commentId"
       RETURNING m."commentId", m."liftGrantedVersion" AS version`,
      [commentId, actorId, systemUserId, reportId, FP_AUTO_HIDE_REPORT_COMMENT]
    );
    if (!lifted) return { changed: true, lifted: null };
    await rows(
      trx,
      `INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
       VALUES ($1, 'commentV3', 'scanLift', $2), ($1, 'report', 'scanLift', $3)
       ON CONFLICT DO NOTHING`,
      [actorId, commentId, reportId]
    );
    return { changed: true, lifted };
  });
}

/** Of these reports, those the scan filed for a hide of its comment, current or since replaced: each is dismissed one at a time. */
export async function scanHideReportIds(db: Kysely<DB>, reportIds: number[]) {
  if (!reportIds.length) return new Set<number>();
  const found = await rows<{ id: number }>(
    db,
    `SELECT "scanHideReportId" AS id FROM "FeaturePageCommentMirror"
     WHERE "scanHideReportId" = ANY($1::int[])`,
    [reportIds]
  );
  return new Set(found.map((r) => r.id));
}

/** Why a moderator's unhide of a Feature Pages comment was not made. */
export type FpUnhideHeld =
  | 'gone'
  | 'changed'
  | 'scan'
  | 'tos'
  | 'foreign'
  | 'held'
  | 'flagged'
  | 'scanning'
  | 'author'
  | 'reported'
  | 'pushing';

/**
 * A moderator shows again a Feature Pages comment a moderator hid, bound to the hide and text version
 * they saw (`seenHiddenAt` is `hiddenAt::text`), and grants that version. Made only over a clean
 * finished scan of the current text (`contentHash`). Never lifts the scan's own hide: its report's
 * Unactioned does (unactionReportLiftingScanHide). `exceptReportId` does not hold the unhide.
 * `held`: nothing was written, and why.
 */
export async function liftModeratorFpHide(
  db: Kysely<DB>,
  {
    commentId,
    actorId,
    systemUserId,
    seenHiddenAt,
    seenVersion,
    exceptReportId,
    contentHash,
  }: {
    commentId: number;
    actorId: number;
    systemUserId: number;
    seenHiddenAt: string;
    seenVersion: number;
    exceptReportId?: number;
    contentHash: string | null;
  }
): Promise<{ lifted: { commentId: number; version: number } } | { held: FpUnhideHeld }> {
  return db.transaction().execute(async (trx) => {
    await lockFpCommentForLift(trx, commentId);
    const [f] = await rows<
      Record<Exclude<FpUnhideHeld, 'gone'> | 'sentLater', boolean> & { at: string }
    >(
      trx,
      `SELECT n.t::text AS at,
         (NOT c.hidden OR c."hiddenAt" IS DISTINCT FROM NULLIF($3, '')::timestamptz OR m.version <> $4
           OR n.t <= c."hiddenAt") AS changed,
         ${FP_SCAN_HIDE} AS scan,
         c."tosViolation" AS tos,
         COALESCE(em.status::text = 'Failed'
           OR (em.status::text = 'Succeeded' AND coalesce(cardinality(em."triggeredLabels"), 0) > 0),
           false) AS flagged,
         em.status IS NULL OR em.status::text NOT IN ('Succeeded', 'Failed') AS scanning,
         ${fpLiftHolds('$2', '$5::int')},
         COALESCE(n.t <= m."modHideSentAt", false) AS "sentLater"
       FROM (SELECT clock_timestamp() AS t) n, "FeaturePageCommentMirror" m
       JOIN "CommentV3" c ON c.id = m."commentId"
       LEFT JOIN "User" u ON u.id = c."userId"
       LEFT JOIN "EntityModeration" em ON em."entityType" = 'CommentV3'
         AND em."entityId" = m."commentId" AND em."contentHash" = $6
       WHERE m."commentId" = $1 AND c."entityType"::text = 'featurePage'
         AND c."deletedAt" IS NULL AND m."goneCause" IS NULL AND m."removeWantedAt" IS NULL`,
      [commentId, systemUserId, seenHiddenAt, seenVersion, exceptReportId ?? null, contentHash]
    );
    if (!f) return { held: 'gone' as const };
    const held = (
      ['changed', 'scan', 'tos', 'flagged', 'scanning', ...FP_LIFT_HOLDS, 'sentLater'] as const
    ).find((why) => f[why]);
    // A hide sent at or after now: the lift would not be strictly after it, as while pushing.
    if (held) return { held: held === 'sentLater' ? 'pushing' : held };
    await rows(
      trx,
      `UPDATE "CommentV3" SET hidden = false, "hiddenAt" = NULL, "updatedAt" = now() WHERE id = $1`,
      [commentId]
    );
    const [lifted] = await rows<{ commentId: number; version: number }>(
      trx,
      `UPDATE "FeaturePageCommentMirror" SET ${fpLiftGrantSet('$3::timestamptz', '$2', 'version')}
       WHERE "commentId" = $1
       RETURNING "commentId", version`,
      [commentId, actorId, f.at]
    );
    await rows(
      trx,
      `INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
       VALUES ($1, 'commentV3', 'fpUnhide', $2) ON CONFLICT DO NOTHING`,
      [actorId, commentId]
    );
    return { lifted };
  });
}

/**
 * What a moderator sees of each live Feature Pages comment's hide, and posts back to hide or unhide
 * it: `hiddenAt` as text, microseconds kept. A comment gone, or owed a removal, has no entry.
 */
export function readFpHideStates(db: Kysely<DB>, commentIds: number[]) {
  if (!commentIds.length) return Promise.resolve([]);
  return rows<{
    commentId: number;
    hidden: boolean;
    hiddenAt: string | null;
    version: number;
    scanHide: boolean;
    tosViolation: boolean;
  }>(
    db,
    `SELECT m."commentId", c.hidden, c."hiddenAt"::text AS "hiddenAt", m.version,
       ${FP_SCAN_HIDE} AS "scanHide", c."tosViolation"
     FROM "FeaturePageCommentMirror" m JOIN "CommentV3" c ON c.id = m."commentId"
     WHERE m."commentId" = ANY($1::int[]) AND c."deletedAt" IS NULL
       AND m."goneCause" IS NULL AND m."removeWantedAt" IS NULL`,
    [commentIds]
  );
}
