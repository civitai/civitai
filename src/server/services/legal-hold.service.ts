import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { userNamedOnHoldingReportSql } from '~/server/utils/legal-hold';

/** What a moderator is told. Never says which hold applies. */
export const LEGAL_HOLD_REFUSAL = 'Account under legal hold; contact Legal.';

/** Thrown when an account may not be deleted. Callers choose the wording; never name the reason. */
export class LegalHoldError extends Error {
  constructor() {
    super('Account under legal hold');
    this.name = 'LegalHoldError';
  }
}

export type AccountHoldLeg = 'report' | 'hold-marker' | 'image-review' | 'image-blocked';

type HoldRow = Record<'report' | 'imageReview' | 'imageBlocked' | 'markerViewExists', unknown>;

/**
 * Which holds cover an account. Reads the primary, so a report filed moments ago counts. Throws on
 * any lookup failure; callers treat that as held.
 */
export async function getAccountLegalHoldLegs(userId: number): Promise<AccountHoldLeg[]> {
  const id = Prisma.sql`${userId}::int`;
  const [row] = await dbWrite.$queryRaw<HoldRow[]>`
    SELECT
      ${userNamedOnHoldingReportSql(id)} AS "report",
      EXISTS (
        SELECT 1 FROM "Image" WHERE "userId" = ${id} AND "needsReview" = 'csam'
      ) AS "imageReview",
      -- A blocked image counts as reported only when a sent report naming them lists it.
      EXISTS (
        SELECT 1 FROM "Image" bi
        WHERE bi."userId" = ${id} AND bi."blockedFor" = 'CSAM'
          AND NOT EXISTS (
            SELECT 1 FROM "CsamReport" sc
            WHERE (sc."userId" = ${id} OR sc.details ->> 'secondaryUserId' = (${id})::text)
              AND sc."reportSentAt" IS NOT NULL
              AND sc.images @> jsonb_build_array(jsonb_build_object('id', bi.id))
          )
      ) AS "imageBlocked",
      to_regclass('"EvidenceHeldUser"') IS NOT NULL AS "markerViewExists"
  `;
  if (!row) throw new Error('Legal hold lookup returned no row');

  const legs: AccountHoldLeg[] = [];
  // Anything but an explicit `false` counts as held.
  if (row.report !== false) legs.push('report');
  if (row.imageReview !== false) legs.push('image-review');
  if (row.imageBlocked !== false) legs.push('image-blocked');

  // A separate statement: a query naming the view fails to parse on a database that lacks it.
  if (row.markerViewExists === true) {
    const [marker] = await dbWrite.$queryRaw<{ held: unknown }[]>`
      SELECT EXISTS (SELECT 1 FROM "EvidenceHeldUser" WHERE "userId" = ${id}) AS held
    `;
    if (marker?.held !== false) legs.push('hold-marker');
  } else if (row.markerViewExists !== false) {
    legs.push('hold-marker');
  }
  return legs;
}

/**
 * Throws `LegalHoldError` when the account is held, or when whether it is held cannot be
 * determined. The reason is logged here and goes no further.
 */
export async function assertAccountNotUnderLegalHold(userId: number): Promise<void> {
  const legs = await legsOrNull(userId);
  if (legs && !legs.length) return;
  if (legs)
    logToAxiom({
      type: 'info',
      name: 'account-legal-hold',
      message: 'Account deletion refused',
      details: { userId, legs },
    });
  throw new LegalHoldError();
}

/** For display: `null` when the status cannot be read, which callers must treat as held. */
export async function isAccountUnderLegalHold(userId: number): Promise<boolean | null> {
  const legs = await legsOrNull(userId);
  return legs ? legs.length > 0 : null;
}

async function legsOrNull(userId: number): Promise<AccountHoldLeg[] | null> {
  try {
    return await getAccountLegalHoldLegs(userId);
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'account-legal-hold-check-failed',
      message: (e as Error).message,
      details: { userId },
    });
    return null;
  }
}
