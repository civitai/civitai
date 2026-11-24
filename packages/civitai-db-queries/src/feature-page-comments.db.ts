import { CompiledQuery, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { csamQueueHeldText } from '@civitai/shared/held-url';

/**
 * The Feature Pages comment mirror's reads and writes. Every read is driven from
 * "FeaturePageCommentMirror" and joins "CommentV3" by primary key: an "entityType" equality on
 * "CommentV3" would scan the whole table.
 */

const rows = async <R>(db: Kysely<DB>, text: string, parameters: unknown[] = []) =>
  (await db.executeQuery<R>(CompiledQuery.raw(text, parameters))).rows;

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
  bannedAt: Date | null;
  muted: boolean | null;
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
};

const FACTS = `
  SELECT m."commentId", m."userId", m."requestId", m.urn, m."goneCause", m.version, m."pushedState",
         m."pushedDigest", m."platformDigest", m."pendingDigest", m."pushAttempts", m."nextPushAt",
         m."updatedAt"::text AS "mirrorUpdatedAt", m."postAttemptedAt", m."subjectMissingAt",
         m."removeWantedAt", m."restrictedAt", m."postSeq", m."goneAt", m."contentAt",
         c.id IS NOT NULL AS "commentExists", c.hidden, c."tosViolation", c."deletedAt", c.content,
         c."createdAt", c."entityId" AS "topicId",
         COALESCE(c."replyToId", c."parentId") AS "parentId",
         t.urn AS "subjectUrn", pm.urn AS "parentUrn",
         u.id IS NOT NULL AS "authorExists", u."deletedAt" AS "authorDeletedAt", u."bannedAt",
         u.muted, u.username,
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
 * `maxAttempts`). Writes no belief about the platform.
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
  await rows(
    db,
    `UPDATE "FeaturePageCommentMirror" SET ${set} WHERE "commentId" = $1 AND "nextPushAt" IS NULL`,
    action === 'stuck' ? [commentId, maxAttempts] : [commentId]
  );
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
