// Import-free: the main app's parity test loads this file by path to compare it with its own SQL.

const PLACEHOLDER_OWNER_ID = -1;

const reportHolds = (hc: string) => `(
    ${hc}."reportSentAt" IS NULL
    OR ${hc}."archivedAt" IS NULL
    OR ${hc}."reportSentAt" > now() - interval '1 year'
  )`;

const legalHoldUserIds = `
  SELECT hc."userId"::text AS "userId"
  FROM "CsamReport" hc
  WHERE hc."userId" IS NOT NULL AND ${reportHolds('hc')}
  UNION
  SELECT hs.details ->> 'secondaryUserId'
  FROM "CsamReport" hs
  WHERE hs.details ->> 'secondaryUserId' IS NOT NULL AND ${reportHolds('hs')}
`;

const userNamedOnHoldingReport = (id: string) => `((${id})::text IN (${legalHoldUserIds}))`;

const userUnderLegalHold = (id: string) => `(
    ${id} = ${PLACEHOLDER_OWNER_ID}
    OR ${userNamedOnHoldingReport(id)}
    OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" ehu WHERE ehu."userId" = ${id})
  )`;

const accountHold = (id: string) =>
  `(${[
    userNamedOnHoldingReport(id),
    `EXISTS (
      SELECT 1 FROM "Image" hr WHERE hr."userId" = ${id} AND hr."needsReview" = 'csam'
    )`,
    `EXISTS (
      SELECT 1 FROM "Image" bi
      WHERE bi."userId" = ${id} AND bi."blockedFor" = 'CSAM'
        AND NOT EXISTS (
          SELECT 1 FROM "CsamReport" sc
          WHERE (sc."userId" = ${id} OR sc.details ->> 'secondaryUserId' = (${id})::text)
            AND sc."reportSentAt" IS NOT NULL
            AND sc.images @> jsonb_build_array(jsonb_build_object('id', bi.id))
        )
    )`,
    `((${id}) IN (
      SELECT ri."userId"
      FROM "CsamReport" rr
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(rr.images) = 'array' THEN rr.images ELSE '[]'::jsonb END
      ) re
      JOIN "Image" ri
        ON ri.id = CASE WHEN (re ->> 'id') ~ '^[0-9]{1,18}$' THEN (re ->> 'id')::bigint END
      WHERE ${reportHolds('rr')}
    ))`,
    `EXISTS (SELECT 1 FROM "EvidenceHeldUser" WHERE "userId" = ${id})`,
  ].join(' OR ')})`;

/**
 * Whether the owner `id` (an int SQL expression) is held: the main app's `ownerHeldSql`, which the
 * blocked-image purge puts on its delete. Kept identical by `moderator-delete-hold-parity.test.ts`.
 */
export const ownerHeldSqlText = (id: string) => `(${userUnderLegalHold(id)} OR ${accountHold(id)})`;

/**
 * Each reason the image row `image` (an unaliased table name or alias) may not be deleted. The owner
 * leg covers most images the others do; they stay so the image's own state holds it whatever its
 * owner's holds say.
 */
export const imageDeleteHoldLegs = (image: string) => ({
  review: `${image}."needsReview" IS NOT DISTINCT FROM 'csam'`,
  block: `${image}."blockedFor" IS NOT DISTINCT FROM 'CSAM'`,
  // Any report, whoever it names and however old. An entry is an `{ id }` object or a bare id.
  listed: `(${image}.id)::text IN (
    SELECT listed.id FROM (
      SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
      FROM "CsamReport" lr
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
      ) le
    ) listed
    WHERE listed.id IS NOT NULL
  )`,
  owner: ownerHeldSqlText(`${image}."userId"`),
});

export const imageDeleteHeldSqlText = (image: string) =>
  `(${Object.values(imageDeleteHoldLegs(image)).join('\n  OR ')})`;

/**
 * The main app's `accountHoldSql` with its marker view present. Kept identical by
 * `moderator-delete-hold-parity.test.ts`.
 */
export const accountHoldSqlText = accountHold;

/**
 * Whether a held author wrote a comment in the thread `rootId` (an int SQL expression) or any thread
 * below it: the main app's `heldCommentInTreeSql`, pinned through
 * `detachHeldArticleThreadsSqlText`.
 */
export const heldCommentInTreeSqlText = (rootId: string) => `EXISTS (
    WITH RECURSIVE tree AS (
    SELECT (${rootId})::int AS id
    UNION
    SELECT n.id
    FROM tree
    CROSS JOIN LATERAL (
      SELECT c.id FROM "Thread" c WHERE c."parentThreadId" = tree.id OR c."rootThreadId" = tree.id
      UNION ALL
      SELECT c.id
      FROM "CommentV2" k
      JOIN "Thread" c ON c."commentId" = k.id
      WHERE k."threadId" = tree.id
    ) n
  )
    SELECT 1
    FROM (SELECT DISTINCT hc."userId" FROM tree JOIN "CommentV2" hc ON hc."threadId" = tree.id) a
    WHERE ${accountHold('a."userId"')}
  )`;

/**
 * Detaches the threads of the articles `articleIds` (a query selecting ids) that hold a held
 * author's comment, so the article's delete does not cascade into them: the main app's
 * `detachHeldThreadsSql({ articleId })`.
 */
export const detachHeldArticleThreadsSqlText = (articleIds: string) => `WITH detached_0 AS (
      UPDATE "Thread" t
      SET "articleId" = NULL,
          metadata = COALESCE(t.metadata, '{}'::jsonb) || jsonb_build_object(
            'detachedFrom', jsonb_build_object('articleId'::text, t."articleId"),
            'detachedAt', now()
          )
      WHERE t."articleId" IN (${articleIds}) AND ${heldCommentInTreeSqlText('t.id')}
      RETURNING t.id
    ) SELECT NULL`;

/**
 * Whether a held author has a live comment on the article `articleId` that exists only in
 * CommentV3, which no detach can save: the main app's `heldCommentV3OnArticleSql`.
 */
export const heldCommentV3OnArticleSqlText = (articleId: string) => `EXISTS (
    SELECT 1 FROM "CommentV3" ac
    WHERE ac."entityType" = 'article' AND ac."entityId" = ${articleId} AND ac."deletedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "CommentV2" v WHERE v.id = ac.id)
      AND ${accountHold('ac."userId"')}
  )`;
