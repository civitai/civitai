/**
 * Rollback for a Phase 4 write flip (docs/comments-consolidation-checklist.md, "Phase 3"): brings
 * the old comment tables up to date with CommentV3. Steps are idempotent. Writes fire the live
 * mirror; its inserts find the v3 row and no-op, but a delete also removes a childless v3 tombstone.
 *
 * The scope says which rows the flipped surface could have touched: `since` is the last converged
 * forward pass before the flip, `until` the moment the flip was reverted, `entityTypes` the flipped
 * surface's types. A v3-only row is copied only if created in [since, until); outside it the row is
 * a ghost the parity report lists. An old row with no v3 row is deleted only if it predates `since`
 * and is on a flipped type (a v3-side hard delete); a newer one is a comment the mirror yielded on.
 * Timestamps travel as ISO strings: the old columns are naive UTC, and a Date would arrive with the
 * driving process's zone offset.
 */
import type { IdRange, SqlRunner } from './comment-v3-backfill.service';

export type ReverseScope = { since: Date; until: Date; entityTypes: string[] };

const one = async <R extends Record<string, unknown>>(
  db: SqlRunner,
  sql: string,
  params?: unknown[]
) => (await db.query<R>(sql, params)).rows[0];

/** Thread column per entity type; comic chapters key on (project, position) and are handled apart. */
const THREAD_COLUMN: Record<string, string> = {
  model: 'modelId',
  image: 'imageId',
  post: 'postId',
  article: 'articleId',
  review: 'reviewId',
  bounty: 'bountyId',
  bountyEntry: 'bountyEntryId',
  challenge: 'challengeId',
  model3d: 'model3dId',
  model3dReview: 'model3dReviewId',
  appListing: 'appListingId',
  crucible: 'crucibleId',
  storyline: 'storylineId',
};

/** The old column holds milliseconds; compare and write at that precision. */
const ms = (expr: string) => `(${expr} AT TIME ZONE 'UTC')::timestamp(3)`;
/** $3 = since, $4 = until, $5 = entity types. */
const inScope = `v."createdAt" >= $3::timestamptz AND v."createdAt" < $4::timestamptz
  AND v."entityType" = ANY(string_to_array($5, ',')::"CommentEntityType"[])`;
const SINCE_OLD = `($3::timestamptz AT TIME ZONE 'UTC')`;

// A model comment follows its root's shape: a chain under one of the v2 rows on a model thread stays
// v2. The root decides, not the parent: a pass copies a chain top-down in separate statements, so
// the parent's old row appears mid-pass and a parent-based test would stamp a grandchild v1-shaped.
const V2_SHAPED_MODEL = `EXISTS (SELECT 1 FROM "CommentV3" r WHERE r.id = v."rootId" AND r."legacyV1Id" IS NULL
  AND (r."createdAt" < $3::timestamptz OR EXISTS (SELECT 1 FROM "CommentV2" c WHERE c.id = r.id)))`;
/**
 * Live v3 rows in scope with no old row. A model comment that is not v2-shaped goes to the v1
 * Comment table the model page reads, with legacyV1Id set to its id first (what the mirror does for
 * a v1 row above the floor).
 */
const PENDING_V2 = `v."legacyV1Id" IS NULL AND v."deletedAt" IS NULL AND (v."entityType" <> 'model' OR ${V2_SHAPED_MODEL}) AND ${inScope}
  AND NOT EXISTS (SELECT 1 FROM "CommentV2" c WHERE c.id = v.id)`;
const PENDING_V1 = `v."entityType" = 'model' AND NOT ${V2_SHAPED_MODEL} AND v."deletedAt" IS NULL AND (v."legacyV1Id" IS NULL OR v."legacyV1Id" = v.id) AND ${inScope}
  AND NOT EXISTS (SELECT 1 FROM "CommentV2" c WHERE c.id = v.id)
  AND NOT EXISTS (SELECT 1 FROM "Comment" c WHERE c.id = COALESCE(v."legacyV1Id", v.id))`;

// The types travel as one comma-joined string: pg and PGlite disagree on how to send an array.
const scopeParams = (r: IdRange, s: ReverseScope) => [
  r.start,
  r.end,
  s.since.toISOString(),
  s.until.toISOString(),
  s.entityTypes.join(','),
];

export type ReverseRootThreadsResult = {
  /** Root Thread rows created for topics that only v3 knows. */
  created: number;
  /** Root threads whose lock was set to the topic's. */
  relocked: number;
};

/**
 * Also re-syncs the topic lock onto root threads that already exist. A v1-shaped model comment goes
 * to `Comment`, which needs no thread, so only v2-shaped ones make one.
 */
export async function reverseRootThreads(
  db: SqlRunner,
  r: IdRange,
  s: ReverseScope
): Promise<ReverseRootThreadsResult> {
  let created = 0;
  let relocked = 0;
  const needs = `(EXISTS (SELECT 1 FROM "CommentV3" v WHERE v."entityType" = ct."entityType" AND v."entityId" = ct."entityId" AND v."parentId" IS NULL
                        AND ${PENDING_V2})
      OR ct.locked
      OR EXISTS (SELECT 1 FROM "CommentTopicMute" m WHERE m."entityType" = ct."entityType" AND m."entityId" = ct."entityId"))`;
  for (const [type, col] of Object.entries(THREAD_COLUMN)) {
    if (!s.entityTypes.includes(type)) continue;
    const { n } = await one<{ n: number }>(
      db,
      `WITH ins AS (
         INSERT INTO "Thread" ("${col}", locked)
         SELECT ct."entityId", ct.locked FROM "CommentTopic" ct
          WHERE ct."entityType" = $6 AND ct."entityId" BETWEEN $1 AND $2 AND ${needs}
            AND NOT EXISTS (SELECT 1 FROM "Thread" t WHERE t."${col}" = ct."entityId")
         ON CONFLICT ("${col}") DO NOTHING
         RETURNING 1
       ) SELECT count(*)::int AS n FROM ins`,
      [...scopeParams(r, s), type]
    );
    created += n;
    const { k } = await one<{ k: number }>(
      db,
      `WITH upd AS (
         UPDATE "Thread" t SET locked = ct.locked
           FROM "CommentTopic" ct
          WHERE ct."entityType" = $3 AND ct."entityId" BETWEEN $1 AND $2
            AND t."${col}" = ct."entityId" AND t."commentId" IS NULL AND t.locked <> ct.locked
         RETURNING 1
       ) SELECT count(*)::int AS k FROM upd`,
      [r.start, r.end, type]
    );
    relocked += k;
  }
  if (s.entityTypes.includes('comicChapter')) {
    const { n } = await one<{ n: number }>(
      db,
      `WITH ins AS (
         INSERT INTO "Thread" ("comicProjectId", "comicChapterPosition", locked)
         SELECT ch."projectId", ch.position, ct.locked
           FROM "CommentTopic" ct JOIN "ComicChapter" ch ON ch.id = ct."entityId"
          WHERE ct."entityType" = 'comicChapter' AND ct."entityId" BETWEEN $1 AND $2 AND ${needs}
            AND NOT EXISTS (SELECT 1 FROM "Thread" t WHERE t."comicProjectId" = ch."projectId" AND t."comicChapterPosition" = ch.position)
         ON CONFLICT ("comicProjectId", "comicChapterPosition") DO NOTHING
         RETURNING 1
       ) SELECT count(*)::int AS n FROM ins`,
      scopeParams(r, s)
    );
    created += n;
    const { k } = await one<{ k: number }>(
      db,
      `WITH upd AS (
         UPDATE "Thread" t SET locked = ct.locked
           FROM "CommentTopic" ct JOIN "ComicChapter" ch ON ch.id = ct."entityId"
          WHERE ct."entityType" = 'comicChapter' AND ct."entityId" BETWEEN $1 AND $2
            AND t."comicProjectId" = ch."projectId" AND t."comicChapterPosition" = ch.position
            AND t."commentId" IS NULL AND t.locked <> ct.locked
         RETURNING 1
       ) SELECT count(*)::int AS k FROM upd`,
      [r.start, r.end]
    );
    relocked += k;
  }
  return { created, relocked };
}

export type ReverseCommentsResult = {
  /** v3-only live comments in the range, both shapes. */
  pending: number;
  /** Reply Thread rows created for v2 parents. */
  threads: number;
  /** Old rows inserted. The rest wait for a parent's old row (run again) or a missing root Thread (run reverseRootThreads). */
  copied: number;
};

/**
 * Old rows for v3-only comments, by v3 id. A v2 reply needs its parent's reply Thread, made here
 * once the parent's old row exists; a clamped reply answers through replyToId. A model comment goes
 * to the v1 table with its parent's v1 id.
 */
export async function reverseComments(
  db: SqlRunner,
  r: IdRange,
  s: ReverseScope
): Promise<ReverseCommentsResult> {
  const p = scopeParams(r, s);
  const { pending } = await one<{ pending: number }>(
    db,
    `SELECT count(*)::int AS pending FROM "CommentV3" v WHERE v.id BETWEEN $1 AND $2 AND (${PENDING_V2} OR ${PENDING_V1})`,
    p
  );
  let { threads } = await one<{ threads: number }>(
    db,
    `WITH parents AS (
       SELECT DISTINCT COALESCE(v."replyToId", v."parentId") AS pid FROM "CommentV3" v
        WHERE v.id BETWEEN $1 AND $2 AND v."parentId" IS NOT NULL AND ${PENDING_V2}
     ), ins AS (
       INSERT INTO "Thread" ("commentId", "parentThreadId", "rootThreadId", locked)
       SELECT p.id, p."threadId", COALESCE(pt."rootThreadId", pt.id), COALESCE(pv.locked, false)
         FROM parents x JOIN "CommentV2" p ON p.id = x.pid JOIN "Thread" pt ON pt.id = p."threadId"
         LEFT JOIN "CommentV3" pv ON pv.id = p.id
        WHERE NOT EXISTS (SELECT 1 FROM "Thread" t WHERE t."commentId" = p.id)
       ON CONFLICT ("commentId") DO NOTHING
       RETURNING 1
     ) SELECT count(*)::int AS threads FROM ins`,
    p
  );
  // An author's removal a hold kept is marked as the old ToS restore reads it, so it is not republished.
  const columns = `(id, content, "userId", "threadId", "tosViolation", hidden, "pinnedAt", "createdAt", "updatedAt", metadata)`;
  const values = `v.id, v.content, v."userId", t.id, v."tosViolation", v.hidden, ${ms(
    'v."pinnedAt"'
  )}, ${ms('v."createdAt"')}, ${ms(
    'v."updatedAt"'
  )}, CASE WHEN v."removedByAuthor" THEN '{"removedByAuthor": true}'::jsonb END`;
  let copied = 0;
  const { replies } = await one<{ replies: number }>(
    db,
    `WITH ins AS (
       INSERT INTO "CommentV2" ${columns}
       SELECT ${values} FROM "CommentV3" v JOIN "Thread" t ON t."commentId" = COALESCE(v."replyToId", v."parentId")
        WHERE v.id BETWEEN $1 AND $2 AND v."parentId" IS NOT NULL AND ${PENDING_V2}
       ON CONFLICT (id) DO NOTHING
       RETURNING 1
     ) SELECT count(*)::int AS replies FROM ins`,
    p
  );
  copied += replies;
  // A reply whose parent is a tombstone with no old row (deleted after the flip, or never in the
  // old table) goes on a reply thread with no parent comment, as a reply stays after its parent's
  // old row is deleted. Its own replies then attach to it on a later pass.
  for (const [type, col] of Object.entries(THREAD_COLUMN)) {
    if (type === 'model' || !s.entityTypes.includes(type)) continue;
    const orphans = await db.query<{ id: number; root: number }>(
      `SELECT v.id, t.id AS root FROM "CommentV3" v
         JOIN "CommentV3" pv ON pv.id = COALESCE(v."replyToId", v."parentId")
         JOIN "Thread" t ON t."${col}" = v."entityId"
        WHERE v.id BETWEEN $1 AND $2 AND v."entityType" = $6 AND v."parentId" IS NOT NULL
          AND ${PENDING_V2}
          AND pv."deletedAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CommentV2" c WHERE c.id = pv.id)`,
      [...p, type]
    );
    for (const { id, root } of orphans.rows) {
      const thread = await one<{ id: number }>(
        db,
        `INSERT INTO "Thread" ("parentThreadId", "rootThreadId") VALUES ($1, $1) RETURNING id`,
        [root]
      );
      threads += 1;
      const { n } = await one<{ n: number }>(
        db,
        `WITH ins AS (
           INSERT INTO "CommentV2" ${columns}
           SELECT ${values} FROM "CommentV3" v JOIN "Thread" t ON t.id = $2 WHERE v.id = $1
           ON CONFLICT (id) DO NOTHING
           RETURNING 1
         ) SELECT count(*)::int AS n FROM ins`,
        [id, thread.id]
      );
      copied += n;
    }
  }
  for (const [type, col] of Object.entries(THREAD_COLUMN)) {
    if (type === 'model' || !s.entityTypes.includes(type)) continue;
    const { n } = await one<{ n: number }>(
      db,
      `WITH ins AS (
         INSERT INTO "CommentV2" ${columns}
         SELECT ${values} FROM "CommentV3" v JOIN "Thread" t ON t."${col}" = v."entityId"
          WHERE v.id BETWEEN $1 AND $2 AND v."entityType" = $6 AND v."parentId" IS NULL AND ${PENDING_V2}
         ON CONFLICT (id) DO NOTHING
         RETURNING 1
       ) SELECT count(*)::int AS n FROM ins`,
      [...p, type]
    );
    copied += n;
  }
  if (s.entityTypes.includes('comicChapter')) {
    const { comics } = await one<{ comics: number }>(
      db,
      `WITH ins AS (
         INSERT INTO "CommentV2" ${columns}
         SELECT ${values} FROM "CommentV3" v
           JOIN "ComicChapter" ch ON ch.id = v."entityId"
           JOIN "Thread" t ON t."comicProjectId" = ch."projectId" AND t."comicChapterPosition" = ch.position
          WHERE v.id BETWEEN $1 AND $2 AND v."entityType" = 'comicChapter' AND v."parentId" IS NULL AND ${PENDING_V2}
         ON CONFLICT (id) DO NOTHING
         RETURNING 1
       ) SELECT count(*)::int AS comics FROM ins`,
      p
    );
    copied += comics;
  }
  if (s.entityTypes.includes('model')) {
    // The mirror would have kept a v1 id above the floor, so the v3 id becomes the Comment id; set
    // first, so the v1 mirror trigger finds the row by legacyV1Id and no-ops on the insert below.
    await db.query(
      `UPDATE "CommentV3" v SET "legacyV1Id" = v.id
        WHERE v.id BETWEEN $1 AND $2 AND v."legacyV1Id" IS NULL AND v.id > commentv3_v1_id_floor() AND ${PENDING_V1}`,
      p
    );
    const { v1 } = await one<{ v1: number }>(
      db,
      `WITH ins AS (
         INSERT INTO "Comment" (id, content, "userId", "modelId", "parentId", "tosViolation", hidden, locked, "pinnedAt", "createdAt", "updatedAt", "removedByAuthor")
         SELECT v.id, v.content, v."userId", v."entityId", p.id, v."tosViolation", v.hidden, v.locked,
                ${ms('v."pinnedAt"')}, ${ms('v."createdAt"')}, ${ms(
        'v."updatedAt"'
      )}, v."removedByAuthor"
           FROM "CommentV3" v
           LEFT JOIN "CommentV3" pv ON pv.id = COALESCE(v."replyToId", v."parentId")
           LEFT JOIN "Comment" p ON p.id = pv."legacyV1Id"
          WHERE v.id BETWEEN $1 AND $2 AND v."legacyV1Id" = v.id AND ${PENDING_V1}
            AND (v."parentId" IS NULL OR p.id IS NOT NULL)
         ON CONFLICT (id) DO NOTHING
         RETURNING 1
       ) SELECT count(*)::int AS v1 FROM ins`,
      p
    );
    copied += v1;
  }
  return { pending, threads, copied };
}

export type ReverseUpdatesResult = {
  /** Old rows whose carried columns were brought up to the v3 row. */
  v2: number;
  v1: number;
  /** Reply Thread locks set to the v3 comment's lock (the thread is created when it is missing). */
  locks: number;
};

/**
 * Edits, flags and locks on rows both sides hold. An old row edited after the v3 row is left alone,
 * which also stops a concurrent old-side edit being overwritten mid-statement; a lock toggled on the
 * old side during the statement can still be reverted, so run this before old-side writes resume.
 */
export async function reverseUpdates(db: SqlRunner, r: IdRange): Promise<ReverseUpdatesResult> {
  const { v2 } = await one<{ v2: number }>(
    db,
    `WITH upd AS (
       UPDATE "CommentV2" c
          SET content = v.content, "tosViolation" = v."tosViolation", hidden = v.hidden,
              "pinnedAt" = ${ms('v."pinnedAt"')}, "updatedAt" = ${ms('v."updatedAt"')},
              metadata = CASE WHEN v."removedByAuthor"
                THEN COALESCE(c.metadata, '{}'::jsonb) || '{"removedByAuthor": true}'::jsonb ELSE c.metadata END
         FROM "CommentV3" v
        WHERE v.id = c.id AND v.id BETWEEN $1 AND $2 AND v."legacyV1Id" IS NULL AND v."deletedAt" IS NULL
          AND c."updatedAt" <= ${ms('v."updatedAt"')}
          AND (c.content <> v.content OR c."tosViolation" <> v."tosViolation" OR COALESCE(c.hidden, false) <> v.hidden
            OR (v."removedByAuthor" AND (c.metadata ->> 'removedByAuthor')::boolean IS NOT TRUE)
            OR c."pinnedAt" IS DISTINCT FROM ${ms('v."pinnedAt"')} OR c."updatedAt" <> ${ms(
      'v."updatedAt"'
    )})
       RETURNING 1
     ) SELECT count(*)::int AS v2 FROM upd`,
    [r.start, r.end]
  );
  const { v1 } = await one<{ v1: number }>(
    db,
    `WITH upd AS (
       UPDATE "Comment" c
          SET content = v.content, "tosViolation" = v."tosViolation", hidden = v.hidden, locked = v.locked,
              "pinnedAt" = ${ms('v."pinnedAt"')}, "updatedAt" = ${ms('v."updatedAt"')},
              "removedByAuthor" = c."removedByAuthor" OR v."removedByAuthor"
         FROM "CommentV3" v
        WHERE v."legacyV1Id" = c.id AND v.id BETWEEN $1 AND $2 AND v."deletedAt" IS NULL
          AND c."updatedAt" <= ${ms('v."updatedAt"')}
          AND (c.content <> v.content OR c."tosViolation" <> v."tosViolation" OR COALESCE(c.hidden, false) <> v.hidden
            OR COALESCE(c.locked, false) <> v.locked
            OR (v."removedByAuthor" AND NOT c."removedByAuthor")
            OR c."pinnedAt" IS DISTINCT FROM ${ms('v."pinnedAt"')} OR c."updatedAt" <> ${ms(
      'v."updatedAt"'
    )})
       RETURNING 1
     ) SELECT count(*)::int AS v1 FROM upd`,
    [r.start, r.end]
  );
  // v2 keeps a comment's lock on its reply Thread, which may not exist yet for a lock set on v3.
  const { made } = await one<{ made: number }>(
    db,
    `WITH ins AS (
       INSERT INTO "Thread" ("commentId", "parentThreadId", "rootThreadId", locked)
       SELECT c.id, c."threadId", COALESCE(pt."rootThreadId", pt.id), true
         FROM "CommentV3" v JOIN "CommentV2" c ON c.id = v.id JOIN "Thread" pt ON pt.id = c."threadId"
        WHERE v.id BETWEEN $1 AND $2 AND v."legacyV1Id" IS NULL AND v."deletedAt" IS NULL AND v.locked
          AND NOT EXISTS (SELECT 1 FROM "Thread" t WHERE t."commentId" = c.id)
       ON CONFLICT ("commentId") DO NOTHING
       RETURNING 1
     ) SELECT count(*)::int AS made FROM ins`,
    [r.start, r.end]
  );
  const { toggled } = await one<{ toggled: number }>(
    db,
    `WITH upd AS (
       UPDATE "Thread" t SET locked = v.locked
         FROM "CommentV3" v
        WHERE t."commentId" = v.id AND v.id BETWEEN $1 AND $2 AND v."legacyV1Id" IS NULL AND v."deletedAt" IS NULL
          AND t.locked <> v.locked
       RETURNING 1
     ) SELECT count(*)::int AS toggled FROM upd`,
    [r.start, r.end]
  );
  return { v2, v1, locks: made + toggled };
}

export type ReverseDeletesResult = {
  /** Old rows removed because their v3 row is tombstoned or, in scope, gone. */
  v2: number;
  v1: number;
  /** v1 tombstones with replies, which the old model can only blank. */
  blanked: number;
};

/**
 * Old rows the v3 side deleted, by old id. A tombstone's old row goes (its reply thread stays, as
 * after a hard delete); an old row with no v3 row goes only inside the scope, where it can only be
 * a v3-side hard delete. A v1 tombstone that still has replies is blanked instead: the old cascade
 * would take the replies with it, and the mirror would then delete them from v3 as well.
 */
export async function reverseDeletes(
  db: SqlRunner,
  r: IdRange,
  s: ReverseScope
): Promise<ReverseDeletesResult> {
  const p = [r.start, r.end, s.since.toISOString(), s.entityTypes.join(',')];
  const { v2 } = await one<{ v2: number }>(
    db,
    `WITH gone AS MATERIALIZED (
       SELECT c.id, c."createdAt", t AS th FROM "CommentV2" c JOIN "Thread" t ON t.id = c."threadId"
        WHERE c.id BETWEEN $1 AND $2
          AND NOT EXISTS (SELECT 1 FROM "CommentV3" v WHERE v.id = c.id AND v."deletedAt" IS NULL)
     ), del AS (
       DELETE FROM "CommentV2" c WHERE c.id IN (
         SELECT g.id FROM gone g
          WHERE EXISTS (SELECT 1 FROM "CommentV3" v WHERE v.id = g.id)
             OR (g."createdAt" < ${SINCE_OLD} AND EXISTS (SELECT 1 FROM commentv3_thread_entity(g.th) e JOIN "CommentTopic" ct
                   ON ct."entityType" = e."entityType" AND ct."entityId" = e."entityId"
                WHERE e."entityType" = ANY(string_to_array($4, ',')::"CommentEntityType"[]))))
       RETURNING 1
     ) SELECT count(*)::int AS v2 FROM del`,
    p
  );
  const { blanked } = await one<{ blanked: number }>(
    db,
    `WITH upd AS (
       UPDATE "Comment" c SET content = ''
         FROM "CommentV3" v
        WHERE v."legacyV1Id" = c.id AND c.id BETWEEN $1 AND $2 AND v."deletedAt" IS NOT NULL AND c.content <> ''
          AND EXISTS (SELECT 1 FROM "Comment" k WHERE k."parentId" = c.id)
       RETURNING 1
     ) SELECT count(*)::int AS blanked FROM upd`,
    [r.start, r.end]
  );
  const { v1 } = await one<{ v1: number }>(
    db,
    `WITH del AS (
       DELETE FROM "Comment" c
        WHERE c.id BETWEEN $1 AND $2
          AND NOT EXISTS (SELECT 1 FROM "Comment" k WHERE k."parentId" = c.id)
          AND NOT EXISTS (SELECT 1 FROM "CommentV3" v WHERE v."legacyV1Id" = c.id AND v."deletedAt" IS NULL)
          AND (c."parentId" IS NULL OR EXISTS (SELECT 1 FROM "Comment" p WHERE p.id = c."parentId"))
          AND (EXISTS (SELECT 1 FROM "CommentV3" v WHERE v."legacyV1Id" = c.id)
            OR (c."createdAt" < ${SINCE_OLD} AND 'model' = ANY(string_to_array($4, ','))
                AND EXISTS (SELECT 1 FROM "CommentTopic" ct WHERE ct."entityType" = 'model' AND ct."entityId" = c."modelId")))
       RETURNING 1
     ) SELECT count(*)::int AS v1 FROM del`,
    p
  );
  return { v2, v1, blanked };
}

export type ReverseLinksResult = {
  reactionsAdded: number;
  reactionsRemoved: number;
  reports: number;
  mutesAdded: number;
  mutesRemoved: number;
};

/**
 * Reactions, report links and comment mutes, by v3 comment id. Reactions and mutes are also removed
 * when v3 lost them; a removed reaction must predate `since`, or it is one the mirror yielded on.
 */
export async function reverseLinks(
  db: SqlRunner,
  r: IdRange,
  s: ReverseScope
): Promise<ReverseLinksResult> {
  const window = [r.start, r.end, s.since.toISOString(), s.until.toISOString()];
  const before = [r.start, r.end, s.since.toISOString()];
  const { v2r } = await one<{ v2r: number }>(
    db,
    `WITH ins AS (
       INSERT INTO "CommentV2Reaction" ("commentId", "userId", reaction, "createdAt", "updatedAt")
       SELECT x."commentId", x."userId", x.reaction, ${ms('x."createdAt"')}, ${ms('x."updatedAt"')}
         FROM "CommentV3Reaction" x JOIN "CommentV3" v ON v.id = x."commentId" AND v."legacyV1Id" IS NULL
         JOIN "CommentV2" c ON c.id = v.id
        WHERE x."commentId" BETWEEN $1 AND $2 AND x."createdAt" >= $3::timestamptz AND x."createdAt" < $4::timestamptz
       ON CONFLICT ("commentId", "userId", reaction) DO NOTHING
       RETURNING 1
     ) SELECT count(*)::int AS v2r FROM ins`,
    window
  );
  const { v1r } = await one<{ v1r: number }>(
    db,
    `WITH ins AS (
       INSERT INTO "CommentReaction" ("commentId", "userId", reaction, "createdAt", "updatedAt")
       SELECT v."legacyV1Id", x."userId", x.reaction, ${ms('x."createdAt"')}, ${ms('x."updatedAt"')}
         FROM "CommentV3Reaction" x JOIN "CommentV3" v ON v.id = x."commentId" AND v."legacyV1Id" IS NOT NULL
         JOIN "Comment" c ON c.id = v."legacyV1Id"
        WHERE x."commentId" BETWEEN $1 AND $2 AND x."createdAt" >= $3::timestamptz AND x."createdAt" < $4::timestamptz
       ON CONFLICT ("commentId", "userId", reaction) DO NOTHING
       RETURNING 1
     ) SELECT count(*)::int AS v1r FROM ins`,
    window
  );
  const { v2d } = await one<{ v2d: number }>(
    db,
    `WITH del AS (
       DELETE FROM "CommentV2Reaction" o
        WHERE o."commentId" BETWEEN $1 AND $2 AND o."createdAt" < ${SINCE_OLD}
          AND EXISTS (SELECT 1 FROM "CommentV3" v WHERE v.id = o."commentId" AND v."deletedAt" IS NULL)
          AND NOT EXISTS (SELECT 1 FROM "CommentV3Reaction" x WHERE x."commentId" = o."commentId" AND x."userId" = o."userId" AND x.reaction = o.reaction)
       RETURNING 1
     ) SELECT count(*)::int AS v2d FROM del`,
    before
  );
  const { v1d } = await one<{ v1d: number }>(
    db,
    `WITH del AS (
       DELETE FROM "CommentReaction" o
        USING "CommentV3" v
        WHERE v.id BETWEEN $1 AND $2 AND v."legacyV1Id" = o."commentId" AND v."deletedAt" IS NULL
          AND o."createdAt" < ${SINCE_OLD}
          AND NOT EXISTS (SELECT 1 FROM "CommentV3Reaction" x WHERE x."commentId" = v.id AND x."userId" = o."userId" AND x.reaction = o.reaction)
       RETURNING 1
     ) SELECT count(*)::int AS v1d FROM del`,
    before
  );
  const { reports } = await one<{ reports: number }>(
    db,
    `WITH v2 AS (
       INSERT INTO "CommentV2Report" ("commentV2Id", "reportId")
       SELECT v.id, x."reportId" FROM "CommentV3Report" x JOIN "CommentV3" v ON v.id = x."commentId" AND v."legacyV1Id" IS NULL
         JOIN "CommentV2" c ON c.id = v.id
        WHERE x."commentId" BETWEEN $1 AND $2
       ON CONFLICT ("reportId") DO NOTHING
       RETURNING 1
     ), v1 AS (
       INSERT INTO "CommentReport" ("commentId", "reportId")
       SELECT v."legacyV1Id", x."reportId" FROM "CommentV3Report" x JOIN "CommentV3" v ON v.id = x."commentId" AND v."legacyV1Id" IS NOT NULL
         JOIN "Comment" c ON c.id = v."legacyV1Id"
        WHERE x."commentId" BETWEEN $1 AND $2
       ON CONFLICT ("reportId") DO NOTHING
       RETURNING 1
     ) SELECT (SELECT count(*) FROM v2)::int + (SELECT count(*) FROM v1)::int AS reports`,
    [r.start, r.end]
  );
  // The reply Thread a comment mute needs is made in its own statement: a row inserted in a CTE is
  // invisible to the next CTE of the same statement.
  await db.query(
    `INSERT INTO "Thread" ("commentId", "parentThreadId", "rootThreadId", locked)
     SELECT c.id, c."threadId", COALESCE(pt."rootThreadId", pt.id), COALESCE(v.locked, false)
       FROM "CommentMute" m JOIN "CommentV2" c ON c.id = m."commentId" JOIN "Thread" pt ON pt.id = c."threadId"
       LEFT JOIN "CommentV3" v ON v.id = c.id
      WHERE m."commentId" BETWEEN $1 AND $2 AND NOT EXISTS (SELECT 1 FROM "Thread" t WHERE t."commentId" = c.id)
     ON CONFLICT ("commentId") DO NOTHING`,
    [r.start, r.end]
  );
  const { mutesAdded } = await one<{ mutesAdded: number }>(
    db,
    `WITH cm AS (
       INSERT INTO "ThreadMute" ("userId", "threadId", "mutedAt")
       SELECT m."userId", t.id, ${ms('m."mutedAt"')}
         FROM "CommentMute" m JOIN "Thread" t ON t."commentId" = m."commentId"
        WHERE m."commentId" BETWEEN $1 AND $2
       ON CONFLICT ("userId", "threadId") DO NOTHING
       RETURNING 1
     ) SELECT (SELECT count(*) FROM cm)::int AS "mutesAdded"`,
    [r.start, r.end]
  );
  const { mutesRemoved } = await one<{ mutesRemoved: number }>(
    db,
    `WITH del AS (
       DELETE FROM "ThreadMute" m
        USING "Thread" t, "CommentV3" v
        WHERE t.id = m."threadId" AND t."commentId" = v.id AND v.id BETWEEN $1 AND $2 AND v."deletedAt" IS NULL
          AND m."mutedAt" < ${SINCE_OLD}
          AND NOT EXISTS (SELECT 1 FROM "CommentMute" x WHERE x."userId" = m."userId" AND x."commentId" = v.id)
       RETURNING 1
     ) SELECT count(*)::int AS "mutesRemoved" FROM del`,
    before
  );
  return {
    reactionsAdded: v2r + v1r,
    reactionsRemoved: v2d + v1d,
    reports,
    mutesAdded,
    mutesRemoved,
  };
}

export type ReverseTopicMutesResult = { added: number; removed: number };

export async function reverseTopicMutes(
  db: SqlRunner,
  r: IdRange,
  s: ReverseScope
): Promise<ReverseTopicMutesResult> {
  let added = 0;
  let removed = 0;
  for (const [type, col] of Object.entries(THREAD_COLUMN)) {
    if (!s.entityTypes.includes(type)) continue;
    const { n } = await one<{ n: number }>(
      db,
      `WITH ins AS (
         INSERT INTO "ThreadMute" ("userId", "threadId", "mutedAt")
         SELECT m."userId", t.id, ${ms('m."mutedAt"')}
           FROM "CommentTopicMute" m JOIN "Thread" t ON t."${col}" = m."entityId"
          WHERE m."entityType" = $3 AND m."entityId" BETWEEN $1 AND $2
         ON CONFLICT ("userId", "threadId") DO NOTHING
         RETURNING 1
       ) SELECT count(*)::int AS n FROM ins`,
      [r.start, r.end, type]
    );
    added += n;
    const { k } = await one<{ k: number }>(
      db,
      `WITH del AS (
         DELETE FROM "ThreadMute" m
          USING "Thread" t
          WHERE t.id = m."threadId" AND t."commentId" IS NULL AND t."${col}" BETWEEN $1 AND $2
            AND m."mutedAt" < ($4::timestamptz AT TIME ZONE 'UTC')
            AND EXISTS (SELECT 1 FROM "CommentTopic" ct WHERE ct."entityType" = $3 AND ct."entityId" = t."${col}")
            AND NOT EXISTS (SELECT 1 FROM "CommentTopicMute" x WHERE x."userId" = m."userId" AND x."entityType" = $3 AND x."entityId" = t."${col}")
         RETURNING 1
       ) SELECT count(*)::int AS k FROM del`,
      [r.start, r.end, type, s.since.toISOString()]
    );
    removed += k;
  }
  if (s.entityTypes.includes('comicChapter')) {
    const { n } = await one<{ n: number }>(
      db,
      `WITH ins AS (
         INSERT INTO "ThreadMute" ("userId", "threadId", "mutedAt")
         SELECT m."userId", t.id, ${ms('m."mutedAt"')}
           FROM "CommentTopicMute" m JOIN "ComicChapter" ch ON ch.id = m."entityId"
           JOIN "Thread" t ON t."comicProjectId" = ch."projectId" AND t."comicChapterPosition" = ch.position
          WHERE m."entityType" = 'comicChapter' AND m."entityId" BETWEEN $1 AND $2
         ON CONFLICT ("userId", "threadId") DO NOTHING
         RETURNING 1
       ) SELECT count(*)::int AS n FROM ins`,
      [r.start, r.end]
    );
    added += n;
    const { k } = await one<{ k: number }>(
      db,
      `WITH del AS (
         DELETE FROM "ThreadMute" m
          USING "Thread" t, "ComicChapter" ch
          WHERE t.id = m."threadId" AND t."commentId" IS NULL
            AND ch."projectId" = t."comicProjectId" AND ch.position = t."comicChapterPosition" AND ch.id BETWEEN $1 AND $2
            AND m."mutedAt" < ($3::timestamptz AT TIME ZONE 'UTC')
            AND EXISTS (SELECT 1 FROM "CommentTopic" ct WHERE ct."entityType" = 'comicChapter' AND ct."entityId" = ch.id)
            AND NOT EXISTS (SELECT 1 FROM "CommentTopicMute" x WHERE x."userId" = m."userId" AND x."entityType" = 'comicChapter' AND x."entityId" = ch.id)
         RETURNING 1
       ) SELECT count(*)::int AS k FROM del`,
      [r.start, r.end, s.since.toISOString()]
    );
    removed += k;
  }
  return { added, removed };
}

const REVERSE_PENDING = {
  reverseComments: `SELECT count(*)::int AS n FROM "CommentV3" v WHERE v.id BETWEEN $1 AND $2 AND (${PENDING_V2} OR ${PENDING_V1})`,
  reverseUpdates: `SELECT count(*)::int AS n FROM "CommentV3" v
    LEFT JOIN "CommentV2" c ON c.id = v.id AND v."legacyV1Id" IS NULL
    LEFT JOIN "Comment" c1 ON c1.id = v."legacyV1Id"
    WHERE v.id BETWEEN $1 AND $2 AND v."deletedAt" IS NULL AND COALESCE(c.id, c1.id) IS NOT NULL
      AND ((COALESCE(c."updatedAt", c1."updatedAt") <= ${ms('v."updatedAt"')}
        AND (v.content <> COALESCE(c.content, c1.content) OR v."tosViolation" <> COALESCE(c."tosViolation", c1."tosViolation")
          OR v.hidden <> COALESCE(c.hidden, c1.hidden, false) OR ${ms(
            'v."pinnedAt"'
          )} IS DISTINCT FROM COALESCE(c."pinnedAt", c1."pinnedAt")
          OR ${ms('v."updatedAt"')} <> COALESCE(c."updatedAt", c1."updatedAt")
          OR (c1.id IS NOT NULL AND v.locked <> COALESCE(c1.locked, false))))
        OR (c.id IS NOT NULL AND v.locked <> COALESCE((SELECT t.locked FROM "Thread" t WHERE t."commentId" = c.id), false)))`,
  reverseDeletes: `SELECT (
      SELECT count(*) FROM "CommentV2" c JOIN "Thread" t ON t.id = c."threadId"
       WHERE c.id BETWEEN $1 AND $2 AND NOT EXISTS (SELECT 1 FROM "CommentV3" v WHERE v.id = c.id AND v."deletedAt" IS NULL)
         AND (EXISTS (SELECT 1 FROM "CommentV3" v WHERE v.id = c.id)
           OR (c."createdAt" < ${SINCE_OLD} AND EXISTS (SELECT 1 FROM commentv3_thread_entity(t) e JOIN "CommentTopic" ct
                 ON ct."entityType" = e."entityType" AND ct."entityId" = e."entityId" WHERE e."entityType" = ANY(string_to_array($4, ',')::"CommentEntityType"[]))))
    )::int + (
      SELECT count(*) FROM "Comment" c
       WHERE c.id BETWEEN $1 AND $2
         AND NOT EXISTS (SELECT 1 FROM "Comment" k WHERE k."parentId" = c.id)
         AND NOT EXISTS (SELECT 1 FROM "CommentV3" v WHERE v."legacyV1Id" = c.id AND v."deletedAt" IS NULL)
         AND (c."parentId" IS NULL OR EXISTS (SELECT 1 FROM "Comment" p WHERE p.id = c."parentId"))
         AND (EXISTS (SELECT 1 FROM "CommentV3" v WHERE v."legacyV1Id" = c.id)
           OR (c."createdAt" < ${SINCE_OLD} AND 'model' = ANY(string_to_array($4, ','))
               AND EXISTS (SELECT 1 FROM "CommentTopic" ct WHERE ct."entityType" = 'model' AND ct."entityId" = c."modelId")))
    )::int AS n`,
  reverseLinks: `SELECT count(*)::int AS n FROM "CommentV3Reaction" x JOIN "CommentV3" v ON v.id = x."commentId" AND v."deletedAt" IS NULL
    WHERE x."commentId" BETWEEN $1 AND $2 AND x."createdAt" >= $3::timestamptz AND x."createdAt" < $4::timestamptz
      AND NOT EXISTS (SELECT 1 FROM "CommentV2Reaction" o WHERE o."commentId" = v.id AND o."userId" = x."userId" AND o.reaction = x.reaction)
      AND NOT EXISTS (SELECT 1 FROM "CommentReaction" o WHERE o."commentId" = v."legacyV1Id" AND o."userId" = x."userId" AND o.reaction = x.reaction)`,
};

/** Dry-run counts. Each predicate copies its live step's; edit both together. reverseLinks counts only reactions to add. */
export async function reverseDryCount(
  db: SqlRunner,
  step: keyof typeof REVERSE_PENDING,
  r: IdRange,
  s: ReverseScope
) {
  const params =
    step === 'reverseUpdates'
      ? [r.start, r.end]
      : step === 'reverseLinks'
      ? [r.start, r.end, s.since.toISOString(), s.until.toISOString()]
      : step === 'reverseDeletes'
      ? [r.start, r.end, s.since.toISOString(), s.entityTypes.join(',')]
      : scopeParams(r, s);
  return (await one<{ n: number }>(db, REVERSE_PENDING[step], params)).n;
}
