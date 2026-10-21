import { Prisma } from '@prisma/client';

/** The owner `deleteUser` hands a kept model to. */
const PLACEHOLDER_OWNER_ID = -1;

/**
 * Whether the owner of a model version is under a legal hold: named on a report that is still
 * pending, not yet archived, or sent within the last year. The hold is user-level, so any report
 * naming the owner (as its subject or its secondary user) holds every one of their files, not only
 * the files the report is about.
 *
 * A model whose owner deleted their account and kept it public belongs to the placeholder owner, so
 * who uploaded it is no longer known; its files are held too.
 */
export function ownerUnderLegalHoldSql(modelVersionId: Prisma.Sql): Prisma.Sql {
  // Once the EvidenceHeldUser view is applied, OR in:
  //   EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = hm."userId")
  // Referencing it before its migration is applied fails the whole query.
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM "ModelVersion" hmv
    JOIN "Model" hm ON hm.id = hmv."modelId"
    WHERE hmv.id = ${modelVersionId}
      AND (
        hm."userId" = ${Prisma.raw(String(PLACEHOLDER_OWNER_ID))}
        OR EXISTS (
          SELECT 1
          FROM "CsamReport" hc
          WHERE (hc."userId" = hm."userId" OR hc.details ->> 'secondaryUserId' = hm."userId"::text)
            AND (
              hc."reportSentAt" IS NULL
              OR hc."archivedAt" IS NULL
              OR hc."reportSentAt" > now() - interval '1 year'
            )
        )
      )
  )`;
}

export type LegalHoldSkipReason = 'legal-hold' | 'legal-hold-unknown';

/** Fails closed: only an explicit `false` lets a row through to a delete. */
export function legalHoldSkipReason(held: unknown): LegalHoldSkipReason | null {
  if (held === false) return null;
  return held === true ? 'legal-hold' : 'legal-hold-unknown';
}
