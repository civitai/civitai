import type { ModelStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';

/** The owner `deleteUser` hands a kept model to. */
export const PLACEHOLDER_OWNER_ID = -1;

/**
 * The status a content wipe leaves a model it keeps in: moderator-only, so the owner cannot
 * republish it.
 */
/** The meta keys of a content wipe's removal record on a model it kept and hid. */
export const REMOVED_WITH_OWNER_META_KEYS = [
  'removedWithOwner',
  'statusBeforeRemoval',
  'versionsUnpublishedByRemoval',
] as const;

export const KEPT_MODEL_STATUS = 'UnpublishedViolation' satisfies `${ModelStatus}`;

/** Whether the report aliased `hc` still holds: pending, not yet archived, or sent within the year. */
export const reportHolds = (hc: string) =>
  Prisma.raw(`(
    ${hc}."reportSentAt" IS NULL
    OR ${hc}."archivedAt" IS NULL
    OR ${hc}."reportSentAt" > now() - interval '1 year'
  )`);

/**
 * The users under a legal hold through a report: named on one, as its subject or its secondary
 * user, that is still pending, not yet archived, or sent within the last year. One distinct
 * `"userId"` text per row, never null, since the secondary user is read out of the report's details.
 */
export const legalHoldUserIdsSql = Prisma.sql`
  SELECT hc."userId"::text AS "userId"
  FROM "CsamReport" hc
  WHERE hc."userId" IS NOT NULL AND ${reportHolds('hc')}
  UNION
  SELECT hs.details ->> 'secondaryUserId'
  FROM "CsamReport" hs
  WHERE hs.details ->> 'secondaryUserId' IS NOT NULL AND ${reportHolds('hs')}
`;

/**
 * Whether a user is named on a report that is still pending, not yet archived, or sent within the
 * last year, as its subject or its secondary user. `userId` is an expression: a bound id or a column.
 */
export function userNamedOnHoldingReportSql(userId: Prisma.Sql): Prisma.Sql {
  // Uncorrelated, so Postgres builds the held set once per statement rather than once per row.
  return Prisma.sql`((${userId})::text IN (${legalHoldUserIdsSql}))`;
}

/**
 * Whether a user is under a legal hold. The hold is user-level, so any report naming them holds
 * every one of their files, not only the files the report is about. The placeholder owner is always
 * held: who uploaded what it owns is no longer known. So is an owner with an active hold marker.
 * Names the `EvidenceHeldUser` view, so a database without its migration fails the whole query.
 */
export function userUnderLegalHoldSql(userId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    ${userId} = ${Prisma.raw(String(PLACEHOLDER_OWNER_ID))}
    OR ${userNamedOnHoldingReportSql(userId)}
    OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" ehu WHERE ehu."userId" = ${userId})
  )`;
}

export type LegalHoldSkipReason = 'legal-hold' | 'legal-hold-unknown';

/** Fails closed: only an explicit `false` lets a row through to a delete. */
export function legalHoldSkipReason(held: unknown): LegalHoldSkipReason | null {
  if (held === false) return null;
  return held === true ? 'legal-hold' : 'legal-hold-unknown';
}
