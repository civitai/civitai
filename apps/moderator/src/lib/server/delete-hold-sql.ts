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
