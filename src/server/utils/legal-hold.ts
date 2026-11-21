import type { ModelStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { csamReportNamedUserIdsSql } from '@civitai/shared/held-media';

/** The owner `deleteUser` hands a kept model to. */
export const PLACEHOLDER_OWNER_ID = -1;

/** The meta keys of a content wipe's removal record on a model it kept. */
export const REMOVED_WITH_OWNER_META_KEYS = [
  'removedWithOwner',
  'statusBeforeRemoval',
  'versionsUnpublishedByRemoval',
] as const;

/** `meta` without a content wipe's removal record, for a moderator decision that ends it. */
export function withoutRemovedWithOwner<T extends object>(meta: T): T {
  return Object.fromEntries(
    Object.entries(meta).filter(
      ([key]) => !(REMOVED_WITH_OWNER_META_KEYS as readonly string[]).includes(key)
    )
  ) as T;
}

/** Whether `meta` carries a content wipe's removal record: only a moderator may publish the model. */
export const isRemovedWithOwner = (meta: unknown) =>
  !!meta && typeof meta === 'object' && (meta as Record<string, unknown>).removedWithOwner === true;

/** SQL: the model whose meta is `metaColumn` carries no content wipe's removal record. */
export const notRemovedWithOwnerSql = (metaColumn: string) =>
  Prisma.raw(`(${metaColumn} ->> 'removedWithOwner') IS DISTINCT FROM 'true'`);

/**
 * The status a content wipe moves a published, scheduled or unpublished model it keeps to:
 * moderator-only, so the owner cannot republish it. Any other kept model, a draft say, keeps its
 * status.
 */
export const KEPT_MODEL_STATUS = 'UnpublishedViolation' satisfies `${ModelStatus}`;

/** The statuses a content wipe keeps a model in where it found it. */
export const KEPT_IN_PLACE_STATUSES = [
  'Draft',
  'Training',
  'GatherInterest',
] as const satisfies readonly `${ModelStatus}`[];

/** Whether the report aliased `hc` still holds: pending, not yet archived, or sent within the year. */
export const reportHolds = (hc: string) =>
  Prisma.raw(`(
    ${hc}."reportSentAt" IS NULL
    OR ${hc}."archivedAt" IS NULL
    OR ${hc}."reportSentAt" > now() - interval '1 year'
  )`);

/** The report predicate, over the `"CsamReport"` alias it is given. */
export type ReportFilter = (alias: string) => Prisma.Sql;

/** `csamReportNamedUserIdsSql` for a `ReportFilter`, which must bind no values: only its text is kept. */
export const reportNamedUserIdsSql = (filter: ReportFilter) =>
  Prisma.raw(
    csamReportNamedUserIdsSql((alias) => {
      const predicate = filter(alias);
      if (predicate.values?.length) throw new Error('A report filter must bind no values');
      return predicate.sql;
    })
  );

/**
 * The owners of images a report passing `filter` lists, whoever the report names. Walks the reports'
 * image lists rather than a user's images: the lists are short, an account's images are not. Compared
 * as bigint so an id past int range still matches rather than being skipped.
 */
export const reportListedImageOwnerIdsSql = (filter: ReportFilter) => Prisma.sql`
  SELECT ri."userId"
  FROM "CsamReport" rr
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(rr.images) = 'array' THEN rr.images ELSE '[]'::jsonb END
  ) re
  JOIN "Image" ri
    ON ri.id = CASE WHEN (re ->> 'id') ~ '^[0-9]{1,18}$' THEN (re ->> 'id')::bigint END
  WHERE ${filter('rr')}
`;

/**
 * The users under a legal hold through a report: named on one, as its subject or its secondary
 * user, that is still pending, not yet archived, or sent within the last year.
 */
export const legalHoldUserIdsSql = reportNamedUserIdsSql(reportHolds);

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
