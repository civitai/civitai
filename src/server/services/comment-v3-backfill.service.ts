/**
 * Phase 3 backfill of the CommentV3 tables (docs/comments-consolidation-checklist.md, "Phase 3"). The comment
 * copies call the mirror's row functions (commentv3_mirror_v1/v2), so a backfilled row is what the
 * mirror would have written. Driven by `src/pages/api/admin/temp/comment-v3-backfill.ts`.
 */

export type SqlRunner = {
  query: <R extends Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: R[] }>;
};

export type IdRange = { start: number; end: number };

export type CopyResult = {
  /** Unmirrored source rows in the range that no deleter held when the step began. */
  pending: number;
  /** Rows the step mirrored. The rest have no home (see unmirroredReport) or yielded inside the row function. */
  copied: number;
  /** v2 only: mirrored comments whose lock was re-synced from their reply Thread. */
  relocked?: number;
};

const one = async <R extends Record<string, unknown>>(
  db: SqlRunner,
  sql: string,
  params?: unknown[]
) => (await db.query<R>(sql, params)).rows[0];

export async function countPendingV2(db: SqlRunner, r: IdRange) {
  return (
    await one<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM "CommentV2" c
        WHERE c.id BETWEEN $1 AND $2 AND NOT EXISTS (SELECT 1 FROM "CommentV3" v WHERE v.id = c.id)`,
      [r.start, r.end]
    )
  ).n;
}

// A locking CTE is not inlined, so each row is locked before the row function sees it. src selects
// the whole row so the function gets the version it locked.

/** v2 comments by id. Ancestors not yet mirrored are copied first, so batch order does not matter. */
export async function copyV2Comments(db: SqlRunner, r: IdRange): Promise<CopyResult> {
  const copied = await one<CopyResult>(
    db,
    `WITH src AS (
       SELECT c AS row FROM "CommentV2" c
        WHERE c.id BETWEEN $1 AND $2 AND NOT EXISTS (SELECT 1 FROM "CommentV3" v WHERE v.id = c.id)
        ORDER BY c.id
        FOR KEY SHARE SKIP LOCKED
     ), done AS (
       SELECT commentv3_mirror_v2(s.row) AS id FROM src s
     )
     SELECT count(*)::int AS pending, count(id)::int AS copied FROM done`,
    [r.start, r.end]
  );
  // An unlock of a reply Thread that commits while its comment's copy is still uncommitted is dropped
  // by the mirror (its probe finds no row and an unlock copies nothing), so the lock is re-read here.
  // Only mismatched rows are locked: holding every copy would let a concurrent delete yield a ghost.
  const relocked = await one<{ n: number }>(
    db,
    `WITH upd AS (
       UPDATE "CommentV3" v SET locked = t.locked
         FROM "Thread" t
        WHERE t."commentId" = v.id AND v.locked <> t.locked
          AND v.id IN (SELECT x.id FROM "CommentV3" x JOIN "Thread" tx ON tx."commentId" = x.id
                        WHERE x.id BETWEEN $1 AND $2 AND x."legacyV1Id" IS NULL AND x."deletedAt" IS NULL
                          AND x.locked <> tx.locked
                        FOR NO KEY UPDATE OF x SKIP LOCKED)
       RETURNING 1
     ) SELECT count(*)::int AS n FROM upd`,
    [r.start, r.end]
  );
  return { ...copied, relocked: relocked.n };
}

export async function countPendingV1(db: SqlRunner, r: IdRange) {
  return (
    await one<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM "Comment" c
        WHERE c.id BETWEEN $1 AND $2 AND NOT EXISTS (SELECT 1 FROM "CommentV3" v WHERE v."legacyV1Id" = c.id)`,
      [r.start, r.end]
    )
  ).n;
}

/** v1 (model) comments by id; the model topic is created on demand, as the mirror does. */
export async function copyV1Comments(db: SqlRunner, r: IdRange): Promise<CopyResult> {
  return one<CopyResult>(
    db,
    `WITH src AS (
       SELECT c AS row FROM "Comment" c
        WHERE c.id BETWEEN $1 AND $2 AND NOT EXISTS (SELECT 1 FROM "CommentV3" v WHERE v."legacyV1Id" = c.id)
        ORDER BY c.id
        FOR KEY SHARE SKIP LOCKED
     ), done AS (
       SELECT commentv3_mirror_v1(s.row) AS id FROM src s
     )
     SELECT count(*)::int AS pending, count(id)::int AS copied FROM done`,
    [r.start, r.end]
  );
}

/** Qualifying root threads (see copyTopics) whose entity resolves but whose topic does not exist yet; after a converged pass, only those whose entity row is gone. */
export async function countPendingTopics(db: SqlRunner, r: IdRange) {
  return (
    await one<{ n: number }>(
      db,
      `WITH roots AS MATERIALIZED (
         SELECT t AS th FROM "Thread" t
          WHERE t.id BETWEEN $1 AND $2 AND t."commentId" IS NULL AND t."parentThreadId" IS NULL
            AND (t.locked OR EXISTS (SELECT 1 FROM "CommentV2" c WHERE c."threadId" = t.id) OR EXISTS (SELECT 1 FROM "ThreadMute" m WHERE m."threadId" = t.id))
       )
       SELECT count(*)::int AS n FROM roots r, LATERAL commentv3_thread_entity(r.th) e
        WHERE e."entityType" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "CommentTopic" ct WHERE ct."entityType" = e."entityType" AND ct."entityId" = e."entityId")`,
      [r.start, r.end]
    )
  ).n;
}

export type TopicResult = {
  /** Root threads in the range that carry a comment, a lock or a mute. */
  pending: number;
  /** Threads whose topic now exists (created here or already present). */
  copied: number;
  /** Topics whose lock was changed to match their root thread. */
  locked: number;
};

/**
 * One topic per root Thread that carries a comment, a lock or a mute, by Thread id. A thread whose
 * entity resolves to nothing, or is gone or mid-delete, counts in `pending` but not `copied`. The
 * comment copies create the other topics on demand.
 */
export async function copyTopics(db: SqlRunner, r: IdRange): Promise<TopicResult> {
  const ensured = await one<{ pending: number; copied: number }>(
    db,
    `SELECT count(*)::int AS pending, count(*) FILTER (WHERE ok)::int AS copied FROM (
       SELECT CASE WHEN e."entityType" IS NULL THEN false
                   ELSE commentv3_ensure_topic(e."entityType", e."entityId", t.locked) END AS ok
         FROM "Thread" t, LATERAL commentv3_thread_entity(t) e
        WHERE t.id BETWEEN $1 AND $2 AND t."commentId" IS NULL AND t."parentThreadId" IS NULL AND (t.locked OR EXISTS (SELECT 1 FROM "CommentV2" c WHERE c."threadId" = t.id) OR EXISTS (SELECT 1 FROM "ThreadMute" m WHERE m."threadId" = t.id))
     ) s`,
    [r.start, r.end]
  );
  // ensure_topic sets the lock only on creation, and an existing topic may predate a toggle the
  // mirror never saw.
  const locked = await one<{ n: number }>(
    db,
    `WITH upd AS (
       UPDATE "CommentTopic" ct SET locked = t.locked
         FROM "Thread" t, LATERAL commentv3_thread_entity(t) e
        WHERE t.id BETWEEN $1 AND $2 AND t."commentId" IS NULL AND t."parentThreadId" IS NULL AND (t.locked OR EXISTS (SELECT 1 FROM "CommentV2" c WHERE c."threadId" = t.id) OR EXISTS (SELECT 1 FROM "ThreadMute" m WHERE m."threadId" = t.id))
          AND ct."entityType" = e."entityType" AND ct."entityId" = e."entityId" AND ct.locked <> t.locked
        RETURNING 1
     ) SELECT count(*)::int AS n FROM upd`,
    [r.start, r.end]
  );
  return { ...ensured, locked: locked.n };
}

const LINK_PENDING = {
  v2Reactions: `SELECT count(*)::int AS n FROM "CommentV2Reaction" r JOIN "CommentV3" v ON v.id = r."commentId"
    WHERE r.id BETWEEN $1 AND $2
      AND NOT EXISTS (SELECT 1 FROM "CommentV3Reaction" x WHERE x."commentId" = v.id AND x."userId" = r."userId" AND x.reaction = r.reaction)`,
  v1Reactions: `SELECT count(*)::int AS n FROM "CommentReaction" r JOIN "CommentV3" v ON v."legacyV1Id" = r."commentId"
    WHERE r.id BETWEEN $1 AND $2
      AND NOT EXISTS (SELECT 1 FROM "CommentV3Reaction" x WHERE x."commentId" = v.id AND x."userId" = r."userId" AND x.reaction = r.reaction)`,
  v2Reports: `SELECT count(*)::int AS n FROM "CommentV2Report" r JOIN "CommentV3" v ON v.id = r."commentV2Id"
    WHERE r."reportId" BETWEEN $1 AND $2 AND NOT EXISTS (SELECT 1 FROM "CommentV3Report" x WHERE x."reportId" = r."reportId")`,
  v1Reports: `SELECT count(*)::int AS n FROM "CommentReport" r JOIN "CommentV3" v ON v."legacyV1Id" = r."commentId"
    WHERE r."reportId" BETWEEN $1 AND $2 AND NOT EXISTS (SELECT 1 FROM "CommentV3Report" x WHERE x."reportId" = r."reportId")`,
};

/** Links in the range whose comment is mirrored but whose link is not. */
export async function countPendingLinks(
  db: SqlRunner,
  step: keyof typeof LINK_PENDING,
  r: IdRange
) {
  return (await one<{ n: number }>(db, LINK_PENDING[step], [r.start, r.end])).n;
}

export type LinkResult = {
  /** Source rows in the range. */
  pending: number;
  /** Links inserted. */
  copied: number;
  /** Source rows whose comment is not mirrored, or is held by a deleter. A later pass picks them up unless the comment is skipped for good. */
  unmirrored: number;
};

// Link steps lock the link row, then the old comment, then the v3 one, as the mirror's triggers do:
// a deleter blocks on the old row before it can hold the v3 row that the link's count update needs,
// and an unlink waits on the link row, so its mirror sees the committed copy and removes it.
// Reactions take SHARE, not KEY SHARE, so a non-key UPDATE (updatedAt) of the old row also waits.

/** v2 reactions by reaction id. */
export async function copyV2Reactions(db: SqlRunner, r: IdRange): Promise<LinkResult> {
  return one<LinkResult>(
    db,
    `WITH src AS (
       SELECT r."commentId", r."userId", r.reaction, r."createdAt", r."updatedAt"
         FROM "CommentV2Reaction" r WHERE r.id BETWEEN $1 AND $2 FOR SHARE SKIP LOCKED
     ), old AS (
       SELECT c.id FROM "CommentV2" c WHERE c.id IN (SELECT "commentId" FROM src) FOR KEY SHARE SKIP LOCKED
     ), locked AS (
       SELECT v.id FROM "CommentV3" v WHERE v.id IN (SELECT id FROM old) FOR KEY SHARE SKIP LOCKED
     ), ins AS (
       INSERT INTO "CommentV3Reaction" ("commentId", "userId", reaction, "createdAt", "updatedAt")
       SELECT s."commentId", s."userId", s.reaction, s."createdAt" AT TIME ZONE 'UTC', s."updatedAt" AT TIME ZONE 'UTC'
         FROM src s JOIN locked l ON l.id = s."commentId"
       ON CONFLICT ("commentId", "userId", reaction) DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM src)::int AS pending,
            (SELECT count(*) FROM ins)::int AS copied,
            (SELECT count(*) FROM src s WHERE NOT EXISTS (SELECT 1 FROM locked l WHERE l.id = s."commentId"))::int AS unmirrored`,
    [r.start, r.end]
  );
}

/** v1 reactions by reaction id, mapped through legacyV1Id. */
export async function copyV1Reactions(db: SqlRunner, r: IdRange): Promise<LinkResult> {
  return one<LinkResult>(
    db,
    `WITH src AS (
       SELECT r."commentId", r."userId", r.reaction, r."createdAt", r."updatedAt"
         FROM "CommentReaction" r WHERE r.id BETWEEN $1 AND $2 FOR SHARE SKIP LOCKED
     ), old AS (
       SELECT c.id FROM "Comment" c WHERE c.id IN (SELECT "commentId" FROM src) FOR KEY SHARE SKIP LOCKED
     ), locked AS (
       SELECT v.id, v."legacyV1Id" FROM "CommentV3" v
        WHERE v."legacyV1Id" IN (SELECT id FROM old) FOR KEY SHARE SKIP LOCKED
     ), ins AS (
       INSERT INTO "CommentV3Reaction" ("commentId", "userId", reaction, "createdAt", "updatedAt")
       SELECT l.id, s."userId", s.reaction, s."createdAt" AT TIME ZONE 'UTC', s."updatedAt" AT TIME ZONE 'UTC'
         FROM src s JOIN locked l ON l."legacyV1Id" = s."commentId"
       ON CONFLICT ("commentId", "userId", reaction) DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM src)::int AS pending,
            (SELECT count(*) FROM ins)::int AS copied,
            (SELECT count(*) FROM src s WHERE NOT EXISTS (SELECT 1 FROM locked l WHERE l."legacyV1Id" = s."commentId"))::int AS unmirrored`,
    [r.start, r.end]
  );
}

/** v2 report links by report id. */
export async function copyV2Reports(db: SqlRunner, r: IdRange): Promise<LinkResult> {
  return one<LinkResult>(
    db,
    `WITH src AS (
       SELECT r."commentV2Id" AS "commentId", r."reportId" FROM "CommentV2Report" r WHERE r."reportId" BETWEEN $1 AND $2 FOR KEY SHARE SKIP LOCKED
     ), old AS (
       SELECT c.id FROM "CommentV2" c WHERE c.id IN (SELECT "commentId" FROM src) FOR KEY SHARE SKIP LOCKED
     ), locked AS (
       SELECT v.id FROM "CommentV3" v WHERE v.id IN (SELECT id FROM old) FOR KEY SHARE SKIP LOCKED
     ), ins AS (
       INSERT INTO "CommentV3Report" ("reportId", "commentId")
       SELECT s."reportId", l.id FROM src s JOIN locked l ON l.id = s."commentId"
       ON CONFLICT ("reportId") DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM src)::int AS pending,
            (SELECT count(*) FROM ins)::int AS copied,
            (SELECT count(*) FROM src s WHERE NOT EXISTS (SELECT 1 FROM locked l WHERE l.id = s."commentId"))::int AS unmirrored`,
    [r.start, r.end]
  );
}

/** v1 report links by report id, mapped through legacyV1Id. */
export async function copyV1Reports(db: SqlRunner, r: IdRange): Promise<LinkResult> {
  return one<LinkResult>(
    db,
    `WITH src AS (
       SELECT r."commentId", r."reportId" FROM "CommentReport" r WHERE r."reportId" BETWEEN $1 AND $2 FOR KEY SHARE SKIP LOCKED
     ), old AS (
       SELECT c.id FROM "Comment" c WHERE c.id IN (SELECT "commentId" FROM src) FOR KEY SHARE SKIP LOCKED
     ), locked AS (
       SELECT v.id, v."legacyV1Id" FROM "CommentV3" v
        WHERE v."legacyV1Id" IN (SELECT id FROM old) FOR KEY SHARE SKIP LOCKED
     ), ins AS (
       INSERT INTO "CommentV3Report" ("reportId", "commentId")
       SELECT s."reportId", l.id FROM src s JOIN locked l ON l."legacyV1Id" = s."commentId"
       ON CONFLICT ("reportId") DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM src)::int AS pending,
            (SELECT count(*) FROM ins)::int AS copied,
            (SELECT count(*) FROM src s WHERE NOT EXISTS (SELECT 1 FROM locked l WHERE l."legacyV1Id" = s."commentId"))::int AS unmirrored`,
    [r.start, r.end]
  );
}

export type MuteResult = {
  pending: number;
  commentMutes: number;
  topicMutes: number;
  /** Mutes on a thread whose comment is not mirrored or whose entity resolves to nothing. */
  unmirrored: number;
};

/**
 * Every ThreadMute, in one pass, not ranged.
 */
export async function copyMutes(db: SqlRunner): Promise<MuteResult> {
  const comment = await one<{ pending: number; copied: number; unmirrored: number }>(
    db,
    `WITH src AS (
       SELECT m."userId", m."mutedAt", t."commentId"
         FROM "ThreadMute" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."commentId" IS NOT NULL
          FOR KEY SHARE OF m SKIP LOCKED
     ), old AS (
       SELECT c.id FROM "CommentV2" c WHERE c.id IN (SELECT "commentId" FROM src) FOR KEY SHARE SKIP LOCKED
     ), locked AS (
       SELECT v.id FROM "CommentV3" v WHERE v.id IN (SELECT id FROM old) FOR KEY SHARE SKIP LOCKED
     ), ins AS (
       INSERT INTO "CommentMute" ("userId", "commentId", "mutedAt")
       SELECT s."userId", l.id, s."mutedAt" AT TIME ZONE 'UTC' FROM src s JOIN locked l ON l.id = s."commentId"
       ON CONFLICT ("userId", "commentId") DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM src)::int AS pending,
            (SELECT count(*) FROM ins)::int AS copied,
            (SELECT count(*) FROM src s WHERE NOT EXISTS (SELECT 1 FROM locked l WHERE l.id = s."commentId"))::int AS unmirrored`
  );
  const topic = await one<{ pending: number; copied: number; unmirrored: number }>(
    db,
    `WITH roots AS MATERIALIZED (
       SELECT m."userId", m."mutedAt", t AS th
         FROM "ThreadMute" m JOIN "Thread" t ON t.id = m."threadId"
        WHERE t."commentId" IS NULL
          FOR KEY SHARE OF m SKIP LOCKED
     ), src AS (
       SELECT r."userId", r."mutedAt", e."entityType", e."entityId" FROM roots r, LATERAL commentv3_thread_entity(r.th) e
     ), ins AS (
       INSERT INTO "CommentTopicMute" ("userId", "entityType", "entityId", "mutedAt")
       SELECT s."userId", s."entityType", s."entityId", s."mutedAt" AT TIME ZONE 'UTC' FROM src s WHERE s."entityType" IS NOT NULL
       ON CONFLICT ("userId", "entityType", "entityId") DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM src)::int AS pending,
            (SELECT count(*) FROM ins)::int AS copied,
            (SELECT count(*) FROM src WHERE "entityType" IS NULL)::int AS unmirrored`
  );
  return {
    pending: comment.pending + topic.pending,
    commentMutes: comment.copied,
    topicMutes: topic.copied,
    unmirrored: comment.unmirrored + topic.unmirrored,
  };
}

export type Finding = { count: number; sample: number[] };

const finding = async (db: SqlRunner, selectIds: string): Promise<Finding> => {
  const rows = (
    await db.query<{ id: number; total: number }>(
      `SELECT id, count(*) OVER ()::int AS total FROM (${selectIds}) m ORDER BY id LIMIT 10`
    )
  ).rows;
  return { count: rows[0]?.total ?? 0, sample: rows.map((r) => r.id) };
};

/**
 * Old rows not yet mirrored, by reason. v2_no_thread, v*_dead_parent, v2_unresolved_entity and
 * v*_no_topic are skipped by design and counted; the rest are what another pass copies.
 */
export async function unmirroredReport(db: SqlRunner) {
  const v2Missing = `NOT EXISTS (SELECT 1 FROM "CommentV3" v WHERE v.id = c.id)`;
  const v1Missing = `NOT EXISTS (SELECT 1 FROM "CommentV3" v WHERE v."legacyV1Id" = c.id)`;
  return {
    v2_pending: await finding(db, `SELECT c.id FROM "CommentV2" c WHERE ${v2Missing}`),
    /** The thread row itself is gone (an orphan the FK cascade predates). */
    v2_no_thread: await finding(
      db,
      `SELECT c.id FROM "CommentV2" c WHERE ${v2Missing} AND NOT EXISTS (SELECT 1 FROM "Thread" t WHERE t.id = c."threadId")`
    ),
    /** Reply whose parent comment no longer exists (its Thread.commentId was nulled by a hard delete). */
    v2_dead_parent: await finding(
      db,
      `SELECT c.id FROM "CommentV2" c JOIN "Thread" t ON t.id = c."threadId"
        WHERE ${v2Missing} AND t."parentThreadId" IS NOT NULL AND t."commentId" IS NULL`
    ),
    /** Thread chain resolves to no supported entity (question/answer/clubPost, or a broken chain). */
    v2_unresolved_entity: await finding(
      db,
      `WITH pending AS MATERIALIZED (
         SELECT c.id, t AS th FROM "CommentV2" c JOIN "Thread" t ON t.id = c."threadId"
          WHERE ${v2Missing} AND NOT (t."parentThreadId" IS NOT NULL AND t."commentId" IS NULL)
       )
       SELECT p.id FROM pending p, LATERAL commentv3_thread_entity(p.th) e WHERE e."entityType" IS NULL`
    ),
    /** Entity resolves but has no topic: normally the entity row is gone and the partition FK refuses it; also lists rows whose topic step has not run. */
    v2_no_topic: await finding(
      db,
      `WITH pending AS MATERIALIZED (
         SELECT c.id, t AS th FROM "CommentV2" c JOIN "Thread" t ON t.id = c."threadId" WHERE ${v2Missing}
       )
       SELECT p.id FROM pending p, LATERAL commentv3_thread_entity(p.th) e
        WHERE e."entityType" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "CommentTopic" ct WHERE ct."entityType" = e."entityType" AND ct."entityId" = e."entityId")`
    ),
    /** Pending rows none of the classes above explain: what the monitor pages on, with its own sample. */
    v2_pending_unexplained: await finding(
      db,
      `WITH pending AS MATERIALIZED (
         SELECT c.id, t AS th FROM "CommentV2" c JOIN "Thread" t ON t.id = c."threadId"
          WHERE ${v2Missing} AND NOT (t."parentThreadId" IS NOT NULL AND t."commentId" IS NULL)
       )
       SELECT p.id FROM pending p, LATERAL commentv3_thread_entity(p.th) e
        WHERE e."entityType" IS NOT NULL
          AND EXISTS (SELECT 1 FROM "CommentTopic" ct WHERE ct."entityType" = e."entityType" AND ct."entityId" = e."entityId")`
    ),
    v1_pending: await finding(db, `SELECT c.id FROM "Comment" c WHERE ${v1Missing}`),
    v1_dead_parent: await finding(
      db,
      `SELECT c.id FROM "Comment" c WHERE ${v1Missing} AND c."parentId" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "Comment" p WHERE p.id = c."parentId")`
    ),
    v1_no_topic: await finding(
      db,
      `SELECT c.id FROM "Comment" c WHERE ${v1Missing}
          AND (c."parentId" IS NULL OR EXISTS (SELECT 1 FROM "Comment" p WHERE p.id = c."parentId"))
          AND NOT EXISTS (SELECT 1 FROM "CommentTopic" ct WHERE ct."entityType" = 'model' AND ct."entityId" = c."modelId")`
    ),
    v1_pending_unexplained: await finding(
      db,
      `SELECT c.id FROM "Comment" c WHERE ${v1Missing}
          AND (c."parentId" IS NULL OR EXISTS (SELECT 1 FROM "Comment" p WHERE p.id = c."parentId"))
          AND EXISTS (SELECT 1 FROM "CommentTopic" ct WHERE ct."entityType" = 'model' AND ct."entityId" = c."modelId")`
    ),
    /** Links not yet copied. mutes_pending also counts mutes whose comment is not mirrored. */
    v2_reactions_pending: await finding(
      db,
      `SELECT r.id FROM "CommentV2Reaction" r JOIN "CommentV3" v ON v.id = r."commentId"
        WHERE NOT EXISTS (SELECT 1 FROM "CommentV3Reaction" x WHERE x."commentId" = v.id AND x."userId" = r."userId" AND x.reaction = r.reaction)`
    ),
    v1_reactions_pending: await finding(
      db,
      `SELECT r.id FROM "CommentReaction" r JOIN "CommentV3" v ON v."legacyV1Id" = r."commentId"
        WHERE NOT EXISTS (SELECT 1 FROM "CommentV3Reaction" x WHERE x."commentId" = v.id AND x."userId" = r."userId" AND x.reaction = r.reaction)`
    ),
    v2_reports_pending: await finding(
      db,
      `SELECT r."reportId" AS id FROM "CommentV2Report" r JOIN "CommentV3" v ON v.id = r."commentV2Id"
        WHERE NOT EXISTS (SELECT 1 FROM "CommentV3Report" x WHERE x."reportId" = r."reportId")`
    ),
    v1_reports_pending: await finding(
      db,
      `SELECT r."reportId" AS id FROM "CommentReport" r JOIN "CommentV3" v ON v."legacyV1Id" = r."commentId"
        WHERE NOT EXISTS (SELECT 1 FROM "CommentV3Report" x WHERE x."reportId" = r."reportId")`
    ),
    mutes_pending: await finding(
      db,
      `SELECT m."threadId" AS id FROM "ThreadMute" m JOIN "Thread" t ON t.id = m."threadId", LATERAL commentv3_thread_entity(t) e
        WHERE CASE WHEN t."commentId" IS NOT NULL
                   THEN NOT EXISTS (SELECT 1 FROM "CommentMute" x WHERE x."userId" = m."userId" AND x."commentId" = t."commentId")
                   ELSE e."entityType" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CommentTopicMute" x
                          WHERE x."userId" = m."userId" AND x."entityType" = e."entityType" AND x."entityId" = e."entityId") END`
    ),
  };
}

/**
 * Old side against new, for the Phase 3 gate. Every finding must be zero except the ones the plan
 * accepts and names: `tombstones_childless` (two concurrent deletes) and `topic_mutes_orphaned`
 * (entity deleted after the mute), both cleared by `sweep`. Counts compare live rows: a tombstone
 * answers to a deleted old row, and `CommentTopic.commentCount` counts tombstones because the
 * trigger does, so it is checked against its own rows, not against the old count.
 */
export async function parityReport(db: SqlRunner) {
  const live = `"deletedAt" IS NULL`;
  return {
    /** A live v3 row whose old row is gone: a delete the mirror yielded to, whose cascade then rolled back. */
    v2_ghosts: await finding(
      db,
      `SELECT v.id FROM "CommentV3" v WHERE v.${live} AND v."legacyV1Id" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "CommentV2" c WHERE c.id = v.id)`
    ),
    v1_ghosts: await finding(
      db,
      `SELECT v.id FROM "CommentV3" v WHERE v.${live} AND v."legacyV1Id" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "Comment" c WHERE c.id = v."legacyV1Id")`
    ),
    // reverseDeletes blanks (content = '') a v1 tombstone that still has replies; it counts as that tombstone's twin.
    resurrected: await finding(
      db,
      `SELECT v.id FROM "CommentV3" v WHERE v."deletedAt" IS NOT NULL
        AND (EXISTS (SELECT 1 FROM "CommentV2" c WHERE c.id = v.id AND v."legacyV1Id" IS NULL)
          OR EXISTS (SELECT 1 FROM "Comment" c WHERE c.id = v."legacyV1Id" AND c.content <> ''))`
    ),
    tombstones_childless: await finding(
      db,
      `SELECT t.id FROM "CommentV3" t WHERE t."deletedAt" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "CommentV3" c WHERE c."parentId" = t.id OR c."replyToId" = t.id)`
    ),
    /** A clamped reply answers its old thread through replyToId, not parentId. */
    thread_count_mismatch: await finding(
      db,
      // Threads with no old rows are skipped; v2_ghosts reports their live v3 rows. Roots resolve
      // their entity behind a materialized CTE so the resolver never runs for reply threads; the reply
      // count uses the OR form so both reply indexes serve it.
      `WITH roots AS MATERIALIZED (
         SELECT t AS th, t.id FROM "Thread" t
          WHERE t."commentId" IS NULL AND EXISTS (SELECT 1 FROM "CommentV2" x WHERE x."threadId" = t.id)
       )
       SELECT r.id FROM roots r, LATERAL commentv3_thread_entity(r.th) e
        WHERE EXISTS (SELECT 1 FROM "CommentTopic" ct WHERE ct."entityType" = e."entityType" AND ct."entityId" = e."entityId")
          AND (SELECT count(*) FROM "CommentV2" c WHERE c."threadId" = r.id)
           <> (SELECT count(*) FROM "CommentV3" v WHERE v."entityType" = e."entityType" AND v."entityId" = e."entityId"
                 AND v."parentId" IS NULL AND v."legacyV1Id" IS NULL AND v.${live})
       UNION ALL
       SELECT t.id FROM "Thread" t
        WHERE t."commentId" IS NOT NULL
          AND EXISTS (SELECT 1 FROM "CommentV2" x WHERE x."threadId" = t.id)
          AND EXISTS (SELECT 1 FROM "CommentV3" p WHERE p.id = t."commentId")
          AND (SELECT count(*) FROM "CommentV2" c WHERE c."threadId" = t.id)
           <> (SELECT count(*) FROM "CommentV3" v
                WHERE (v."replyToId" = t."commentId" OR (v."replyToId" IS NULL AND v."parentId" = t."commentId")) AND v.${live})`
    ),
    model_v1_count_mismatch: await finding(
      db,
      // A reply whose parent is gone is skipped by design, so it is not counted.
      `SELECT m."modelId" AS id FROM (SELECT "modelId", count(*) AS n FROM "Comment" c
                                        WHERE (c."parentId" IS NULL OR EXISTS (SELECT 1 FROM "Comment" p WHERE p.id = c."parentId"))
                                          AND NOT (c.content = '' AND EXISTS (SELECT 1 FROM "CommentV3" v WHERE v."legacyV1Id" = c.id AND v."deletedAt" IS NOT NULL))
                                        GROUP BY 1) m
        WHERE EXISTS (SELECT 1 FROM "CommentTopic" ct WHERE ct."entityType" = 'model' AND ct."entityId" = m."modelId")
          AND m.n <> (SELECT count(*) FROM "CommentV3" v WHERE v."entityType" = 'model' AND v."entityId" = m."modelId"
                        AND v."legacyV1Id" IS NOT NULL AND v.${live})`
    ),
    topic_count_mismatch: await finding(
      db,
      `SELECT ct."entityId" AS id FROM "CommentTopic" ct
         LEFT JOIN (SELECT "entityType", "entityId", count(*) AS n FROM "CommentV3" GROUP BY 1, 2) g
                ON g."entityType" = ct."entityType" AND g."entityId" = ct."entityId"
        WHERE ct."commentCount" <> COALESCE(g.n, 0)`
    ),
    reaction_count_mismatch: await finding(
      db,
      `SELECT v.id FROM "CommentV3" v
         LEFT JOIN (SELECT "commentId", count(*) AS n FROM "CommentV3Reaction" GROUP BY 1) g ON g."commentId" = v.id
        WHERE v."reactionCount" <> COALESCE(g.n, 0)`
    ),
    /** A v3 link whose source row is gone (the reverse is v*_reactions_pending in unmirroredReport). */
    v2_reactions_extra: await finding(
      db,
      `SELECT x.id FROM "CommentV3Reaction" x JOIN "CommentV3" v ON v.id = x."commentId" AND v."legacyV1Id" IS NULL
        WHERE NOT EXISTS (SELECT 1 FROM "CommentV2Reaction" r WHERE r."commentId" = x."commentId" AND r."userId" = x."userId" AND r.reaction = x.reaction)`
    ),
    v1_reactions_extra: await finding(
      db,
      `SELECT x.id FROM "CommentV3Reaction" x JOIN "CommentV3" v ON v.id = x."commentId" AND v."legacyV1Id" IS NOT NULL
        WHERE NOT EXISTS (SELECT 1 FROM "CommentReaction" r WHERE r."commentId" = v."legacyV1Id" AND r."userId" = x."userId" AND r.reaction = x.reaction)`
    ),
    reports_extra: await finding(
      db,
      `SELECT x."reportId" AS id FROM "CommentV3Report" x
        WHERE NOT EXISTS (SELECT 1 FROM "CommentV2Report" r WHERE r."reportId" = x."reportId")
          AND NOT EXISTS (SELECT 1 FROM "CommentReport" r WHERE r."reportId" = x."reportId")`
    ),
    topic_lock_mismatch: await finding(
      db,
      `SELECT t.id FROM "Thread" t, LATERAL commentv3_thread_entity(t) e
         JOIN "CommentTopic" ct ON ct."entityType" = e."entityType" AND ct."entityId" = e."entityId"
        WHERE t."commentId" IS NULL AND ct.locked <> t.locked`
    ),
    comment_lock_mismatch: await finding(
      db,
      `SELECT v.id FROM "CommentV3" v
         LEFT JOIN "Thread" t ON t."commentId" = v.id AND v."legacyV1Id" IS NULL
         LEFT JOIN "Comment" c ON c.id = v."legacyV1Id"
        WHERE v.${live} AND v.locked <> COALESCE(t.locked, c.locked, false)`
    ),
    // Old columns are naive UTC at millisecond precision; bring the v3 side to match.
    v2_column_drift: await finding(
      db,
      `SELECT v.id FROM "CommentV3" v JOIN "CommentV2" c ON c.id = v.id AND v."legacyV1Id" IS NULL
        WHERE v.${live} AND (v.content <> c.content OR v.hidden <> COALESCE(c.hidden, false) OR v."tosViolation" <> c."tosViolation"
          OR v."userId" <> c."userId" OR (v."createdAt" AT TIME ZONE 'UTC')::timestamp(3) <> c."createdAt" OR (v."updatedAt" AT TIME ZONE 'UTC')::timestamp(3) <> c."updatedAt"
          OR (v."pinnedAt" AT TIME ZONE 'UTC')::timestamp(3) IS DISTINCT FROM c."pinnedAt")`
    ),
    v1_column_drift: await finding(
      db,
      `SELECT v.id FROM "CommentV3" v JOIN "Comment" c ON c.id = v."legacyV1Id"
        WHERE v.${live} AND (v.content <> c.content OR v.hidden <> COALESCE(c.hidden, false) OR v."tosViolation" <> c."tosViolation"
          OR v."userId" <> c."userId" OR v."entityId" <> c."modelId" OR (v."createdAt" AT TIME ZONE 'UTC')::timestamp(3) <> c."createdAt"
          OR (v."updatedAt" AT TIME ZONE 'UTC')::timestamp(3) <> c."updatedAt" OR (v."pinnedAt" AT TIME ZONE 'UTC')::timestamp(3) IS DISTINCT FROM c."pinnedAt")`
    ),
    /** A clamped v1 reply answers through replyToId. */
    v1_parent_mismatch: await finding(
      db,
      `SELECT v.id FROM "CommentV3" v JOIN "Comment" c ON c.id = v."legacyV1Id"
        WHERE c."parentId" IS NOT NULL
          AND COALESCE(v."replyToId", v."parentId") IS DISTINCT FROM (SELECT p.id FROM "CommentV3" p WHERE p."legacyV1Id" = c."parentId")`
    ),
    mutes_extra: await finding(
      db,
      `SELECT x."commentId" AS id FROM "CommentMute" x
        WHERE NOT EXISTS (SELECT 1 FROM "ThreadMute" m JOIN "Thread" t ON t.id = m."threadId"
                           WHERE m."userId" = x."userId" AND t."commentId" = x."commentId")`
    ),
    topic_mutes_orphaned: await finding(
      db,
      `SELECT x."entityId" AS id FROM "CommentTopicMute" x
        WHERE NOT EXISTS (SELECT 1 FROM "CommentTopic" ct WHERE ct."entityType" = x."entityType" AND ct."entityId" = x."entityId")`
    ),
  };
}

/**
 * The two residues the mirror can leave: tombstones with neither a reply nor an answerer, and topic
 * mutes whose topic is gone. The tombstone half is safe at any time; run the topic-mute half only
 * after the topic copy has converged; a tombstone chain collapses one level per pass,
 * capped at 25, so rerun if `tombstones` is large.
 */
export async function sweep(db: SqlRunner) {
  let tombstones = 0;
  for (let pass = 0; pass < 25; pass++) {
    const { n } = await one<{ n: number }>(
      db,
      `WITH del AS (
         DELETE FROM "CommentV3" t WHERE t.id IN (
           SELECT x.id FROM "CommentV3" x WHERE x."deletedAt" IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM "CommentV3" c WHERE c."parentId" = x.id OR c."replyToId" = x.id)
           FOR UPDATE SKIP LOCKED)
         RETURNING 1
       ) SELECT count(*)::int AS n FROM del`
    );
    tombstones += n;
    if (n === 0) break;
  }
  const { n: topicMutes } = await one<{ n: number }>(
    db,
    `WITH del AS (
       DELETE FROM "CommentTopicMute" x
        WHERE NOT EXISTS (SELECT 1 FROM "CommentTopic" ct WHERE ct."entityType" = x."entityType" AND ct."entityId" = x."entityId")
       RETURNING 1
     ) SELECT count(*)::int AS n FROM del`
  );
  return { tombstones, topicMutes };
}

/** Current row totals of the old and new comment and reaction tables, for the parity record. */
export async function rowTotals(db: SqlRunner): Promise<Record<string, number>> {
  const { rows } = await db.query<{ table: string; n: number }>(
    `SELECT 'CommentV2' AS "table", count(*)::int AS n FROM "CommentV2"
     UNION ALL SELECT 'Comment', count(*)::int FROM "Comment"
     UNION ALL SELECT 'CommentV3', count(*)::int FROM "CommentV3" WHERE "deletedAt" IS NULL
     UNION ALL SELECT 'CommentV2Reaction', count(*)::int FROM "CommentV2Reaction"
     UNION ALL SELECT 'CommentReaction', count(*)::int FROM "CommentReaction"
     UNION ALL SELECT 'CommentV3Reaction', count(*)::int FROM "CommentV3Reaction"`
  );
  return Object.fromEntries(rows.map((r) => [r.table, r.n]));
}

export type ParityVerdict = {
  /** Findings worth paging about: drift the backfill or the mirror should have settled. */
  pages: string[];
  /** Nonzero findings that are known residue: the orphan classes and what `sweep` clears. */
  expected: string[];
};

export function parityVerdict(
  unmirrored: Awaited<ReturnType<typeof unmirroredReport>>,
  parity: Awaited<ReturnType<typeof parityReport>>
): ParityVerdict {
  const line = (name: string, f: Finding) => `${name}: ${f.count} (e.g. ${f.sample.join(', ')})`;
  const pages: string[] = [];
  const expected: string[] = [];
  const residue = new Set([
    'v2_pending',
    'v1_pending',
    'v2_no_thread',
    'v2_dead_parent',
    'v2_unresolved_entity',
    'v2_no_topic',
    'v1_dead_parent',
    'v1_no_topic',
    'tombstones_childless',
    'topic_mutes_orphaned',
  ]);
  for (const [name, f] of Object.entries({ ...unmirrored, ...parity })) {
    if (!f.count) continue;
    (residue.has(name) ? expected : pages).push(line(name, f));
  }
  return { pages, expected };
}
