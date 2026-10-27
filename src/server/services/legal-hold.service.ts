import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  reportHolds,
  userNamedOnHoldingReportSql,
  userUnderLegalHoldSql,
} from '~/server/utils/legal-hold';

/** What a moderator is told. Never says which hold applies. */
export const LEGAL_HOLD_REFUSAL = 'Account under legal hold; contact Legal.';

/** The one definition of a hold marker, and the table behind it. Both may not exist yet. */
export const HOLD_MARKER_VIEW = 'EvidenceHeldUser';
export const HOLD_MARKER_TABLE = 'EvidenceHold';

/** The SQLSTATE the guarded scrub raises when a hold stops it. */
const HOLD_ABORT_CODE = 'LH001';

/** Thrown when an account may not be deleted. Callers choose the wording; never name the reason. */
export class LegalHoldError extends Error {
  constructor() {
    super('Account under legal hold');
    this.name = 'LegalHoldError';
  }
}

/** What a moderator is told when a hold stopped a wipe part-way. Never says which hold applies. */
export const LEGAL_HOLD_STOPPED = 'Purge stopped by a legal hold part-way; contact Legal.';

/** A stopped purge that also left bids unrefunded; the moderator must not read it as nothing owed. */
export const LEGAL_HOLD_STOPPED_REFUNDS_INCOMPLETE = `${LEGAL_HOLD_STOPPED} Some bids were not refunded; see the bid-refund-failed alert.`;

/** A hold that landed after the check stopped a wipe part-way: some of it was already deleted. */
export class LegalHoldStoppedError extends LegalHoldError {
  /** The steps that ran before the stop and failed, as `removeAllContent` names them. */
  constructor(readonly incomplete: string[] = []) {
    super();
    this.name = 'LegalHoldStoppedError';
  }
}

/** What a moderator is told when whether a hold applies could not be read. */
export const HOLD_UNCONFIRMED = "Couldn't check legal hold status; try again.";

/** Whether the account is held could not be read; refused like a hold. */
export class LegalHoldUnconfirmedError extends LegalHoldError {
  constructor() {
    super();
    this.name = 'LegalHoldUnconfirmedError';
  }
}

/** What a moderator is told for a `LegalHoldError`; the most specific class wins. */
export function legalHoldMessage(e: LegalHoldError) {
  if (e instanceof LegalHoldStoppedError)
    return e.incomplete.includes('bid-refunds')
      ? LEGAL_HOLD_STOPPED_REFUNDS_INCOMPLETE
      : LEGAL_HOLD_STOPPED;
  if (e instanceof LegalHoldUnconfirmedError) return HOLD_UNCONFIRMED;
  return LEGAL_HOLD_REFUSAL;
}

export type AccountHoldLeg =
  | 'report'
  | 'hold-marker'
  | 'image-review'
  | 'image-blocked'
  | 'reported-image';

const markerView = Prisma.raw(`"${HOLD_MARKER_VIEW}"`);
const abortCode = Prisma.raw(`'${HOLD_ABORT_CODE}'`);

/** Every hold except the marker, as SQL over `id`, an int expression. */
function holdLegsSql(id: Prisma.Sql) {
  return {
    report: userNamedOnHoldingReportSql(id),
    // Aliased, so `id` may be a column of an outer unaliased "Image" without being captured here.
    'image-review': Prisma.sql`EXISTS (
      SELECT 1 FROM "Image" hr WHERE hr."userId" = ${id} AND hr."needsReview" = 'csam'
    )`,
    // A blocked image counts as reported only when a sent report naming them lists it.
    'image-blocked': Prisma.sql`EXISTS (
      SELECT 1 FROM "Image" bi
      WHERE bi."userId" = ${id} AND bi."blockedFor" = 'CSAM'
        AND NOT EXISTS (
          SELECT 1 FROM "CsamReport" sc
          WHERE (sc."userId" = ${id} OR sc.details ->> 'secondaryUserId' = (${id})::text)
            AND sc."reportSentAt" IS NOT NULL
            AND sc.images @> jsonb_build_array(jsonb_build_object('id', bi.id))
        )
    )`,
    // Any image of theirs listed in a report that still holds, whoever the report names. Walks the
    // reports' image lists rather than the user's images: the lists are short, an account's images
    // are not. Compared as bigint so an id past int range still matches rather than being skipped.
    'reported-image': Prisma.sql`EXISTS (
      SELECT 1
      FROM "CsamReport" rr
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(rr.images) = 'array' THEN rr.images ELSE '[]'::jsonb END
      ) re
      JOIN "Image" ri
        ON ri.id = CASE WHEN (re ->> 'id') ~ '^[0-9]{1,18}$' THEN (re ->> 'id')::bigint END
      WHERE ri."userId" = ${id} AND ${reportHolds('rr')}
    )`,
  } satisfies Partial<Record<AccountHoldLeg, Prisma.Sql>>;
}

const markerSql = (id: Prisma.Sql) =>
  Prisma.sql`EXISTS (SELECT 1 FROM ${markerView} WHERE "userId" = ${id})`;

/**
 * For a statement built when neither marker object existed: held if either exists by the time it
 * runs, since the marker leg it would need is not in it.
 */
const markerAppearedSql = Prisma.raw(
  `(to_regclass('"${HOLD_MARKER_VIEW}"') IS NOT NULL OR to_regclass('"${HOLD_MARKER_TABLE}"') IS NOT NULL)`
);

/** The hold-marker leg of `accountHoldSql` alone. */
export function holdMarkerSql(id: Prisma.Sql, markerView: boolean): Prisma.Sql {
  return markerView ? markerSql(id) : markerAppearedSql;
}

/**
 * Every hold on the account `id` (an int SQL expression) as one condition, for a statement that must
 * not touch a held account's rows even when a hold lands after the check. `markerView` is what
 * `assertAccountNotUnderLegalHold` returned.
 */
export function accountHoldSql(id: Prisma.Sql, markerView: boolean): Prisma.Sql {
  const legs = [...Object.values(holdLegsSql(id)), holdMarkerSql(id, markerView)];
  return Prisma.sql`(${Prisma.join(legs, ' OR ')})`;
}

/**
 * The `markerView` for `accountHoldSql` in a statement over many accounts' rows, where there is no
 * single account to check first. Without the view, `accountHoldSql` holds every row if either marker
 * object exists, so a view that is missing while its table is not still holds.
 */
export async function holdMarkerViewExists(): Promise<boolean> {
  const [row] = await dbWrite.$queryRaw<{ present: unknown }[]>`
    SELECT to_regclass(${`"${HOLD_MARKER_VIEW}"`}) IS NOT NULL AS present
  `;
  return row?.present === true;
}

/** Whether the marker table exists. Without its view, `accountHoldSql` holds every account. */
export async function holdMarkerTableExists(): Promise<boolean> {
  const [row] = await dbWrite.$queryRaw<{ present: unknown }[]>`
    SELECT to_regclass(${`"${HOLD_MARKER_TABLE}"`}) IS NOT NULL AS present
  `;
  return row?.present === true;
}

/** Authors one call logs at most; a bulk delete can retain rows from every author it touched. */
const HOLD_LOG_AUTHORS = 200;

/**
 * Logs the holds that kept rows a moderator's bulk delete asked for. Best-effort, and the reason
 * goes no further than here. An author with no hold of their own had a row kept for a held reply
 * below it.
 */
export async function logHoldRetained(action: string, userIds: number[]) {
  const authors = [...new Set(userIds)];
  const logged = authors.slice(0, HOLD_LOG_AUTHORS);
  const holds = await getAccountLegalHolds(logged).catch((e: unknown) => {
    logToAxiom({
      type: 'error',
      name: 'account-legal-hold-check-failed',
      message: (e as Error).message,
      details: { userIds: logged },
    }).catch(() => undefined);
    return null;
  });
  for (const userId of logged) {
    const legs = holds?.get(userId) ?? null;
    logToAxiom({
      type: 'info',
      name: 'account-legal-hold',
      message: legs?.length === 0 ? `${action}: kept for a held reply` : `${action}: rows retained`,
      details: { userId, legs },
    }).catch(() => undefined);
  }
  if (authors.length > logged.length)
    logToAxiom({
      type: 'info',
      name: 'account-legal-hold',
      message: `${action}: rows retained for ${authors.length - logged.length} more authors`,
    }).catch(() => undefined);
}

export type AccountLegalHold = {
  legs: AccountHoldLeg[];
  /** The marker view exists, so a statement may name it. */
  markerView: boolean;
};

/**
 * Which holds cover an account. Reads the primary, so a report filed moments ago counts. Throws on
 * any lookup failure; callers treat that as held.
 */
export async function getAccountLegalHold(userId: number): Promise<AccountLegalHold> {
  const { legs, markerView } = (await readAccountHolds([userId]))[0];
  return { legs, markerView };
}

/** `getAccountLegalHold` for many accounts, in one statement (two when the marker view exists). */
async function getAccountLegalHolds(userIds: number[]): Promise<Map<number, AccountHoldLeg[]>> {
  if (!userIds.length) return new Map();
  return new Map((await readAccountHolds(userIds)).map((h) => [h.userId, h.legs]));
}

async function readAccountHolds(
  userIds: number[]
): Promise<(AccountLegalHold & { userId: number })[]> {
  const id = Prisma.raw('u."userId"');
  const legs = holdLegsSql(id);
  const rows = await dbWrite.$queryRaw<Record<string, unknown>[]>`
    SELECT
      u."userId",
      ${Prisma.join(
        Object.entries(legs).map(([name, leg]) => Prisma.sql`${leg} AS ${Prisma.raw(`"${name}"`)}`)
      )},
      to_regclass(${`"${HOLD_MARKER_VIEW}"`}) IS NOT NULL AS "markerView",
      to_regclass(${`"${HOLD_MARKER_TABLE}"`}) IS NOT NULL AS "markerTable"
    FROM unnest(${userIds}::int[]) AS u("userId")
  `;
  if (rows.length !== userIds.length) throw new Error('Legal hold lookup returned no row');

  // Anything but an explicit `false` counts as held.
  const held = new Map(
    rows.map((row) => [
      Number(row.userId),
      (Object.keys(legs) as AccountHoldLeg[]).filter((leg) => row[leg] !== false),
    ])
  );
  const markerView = rows[0].markerView === true;

  // A separate statement: a query naming the view fails to parse on a database that lacks it.
  if (markerView) {
    const marks = await dbWrite.$queryRaw<{ userId: number; held: unknown }[]>`
      SELECT u."userId", ${markerSql(id)} AS held FROM unnest(${userIds}::int[]) AS u("userId")
    `;
    const marked = new Map(marks.map((m) => [Number(m.userId), m.held]));
    for (const [userId, legsHeld] of held)
      if (marked.get(userId) !== false) legsHeld.push('hold-marker');
  } else if (!(rows[0].markerView === false && rows[0].markerTable === false)) {
    // The table without its view means the view was dropped or renamed: held until it is back.
    for (const legsHeld of held.values()) legsHeld.push('hold-marker');
  }
  return [...held].map(([userId, legsHeld]) => ({ userId, legs: legsHeld, markerView }));
}

export async function getAccountLegalHoldLegs(userId: number): Promise<AccountHoldLeg[]> {
  return (await getAccountLegalHold(userId)).legs;
}

/**
 * Throws `LegalHoldError` when the account is held, and `LegalHoldUnconfirmedError` when whether it
 * is held cannot be determined. The reason is logged here and goes no further.
 */
export async function assertAccountNotUnderLegalHold(
  userId: number
): Promise<Pick<AccountLegalHold, 'markerView'>> {
  const hold = await holdOrNull(userId);
  if (!hold) throw new LegalHoldUnconfirmedError();
  if (!hold.legs.length) return { markerView: hold.markerView };
  logToAxiom({
    type: 'info',
    name: 'account-legal-hold',
    message: 'Account deletion refused',
    details: { userId, legs: hold.legs },
  });
  throw new LegalHoldError();
}

/**
 * For moving content between owners: the hold the purge jobs read (`userUnderLegalHoldSql`, which
 * includes the placeholder owner) and every account hold, whose image legs follow the images moved.
 * Throws `LegalHoldError` when any of `userIds` is held, `LegalHoldUnconfirmedError` when that cannot
 * be read. Names the marker view, so it needs its migration.
 */
export async function assertOwnersNotUnderLegalHold(userIds: number[]) {
  const owner = Prisma.raw('o."userId"');
  const rows = await dbWrite.$queryRaw<{ userId: number; held: unknown }[]>`
    SELECT o."userId", (${userUnderLegalHoldSql(owner)} OR ${accountHoldSql(owner, true)}) AS held
    FROM unnest(${userIds}::int[]) AS o("userId")
  `.catch((e: unknown) => {
    logToAxiom({
      type: 'error',
      name: 'account-legal-hold-check-failed',
      message: (e as Error).message,
      details: { userIds },
    });
    return null;
  });
  if (!rows || rows.length !== userIds.length) throw new LegalHoldUnconfirmedError();
  const held = rows.filter((r) => r.held !== false).map((r) => r.userId);
  if (!held.length) return;
  logToAxiom({
    type: 'info',
    name: 'account-legal-hold',
    message: 'Owner change refused',
    details: { userIds: held },
  });
  throw new LegalHoldError();
}

/** For display: `null` when the status cannot be read, which callers must treat as held. */
export async function isAccountUnderLegalHold(userId: number): Promise<boolean | null> {
  const hold = await holdOrNull(userId);
  return hold ? hold.legs.length > 0 : null;
}

async function holdOrNull(userId: number): Promise<AccountLegalHold | null> {
  try {
    return await getAccountLegalHold(userId);
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

/**
 * The account scrub with every hold in the same statement, so a hold that lands after the check in
 * `assertAccountNotUnderLegalHold` still stops it. Raises `HOLD_ABORT_CODE` when it changes no row,
 * which fails the whole transaction it runs in.
 *
 * A DO block takes no parameters, so the id is inlined, and only after it is proven a positive safe
 * integer; everything else in it is a constant. Under READ COMMITTED this still sees only what was
 * committed when the statement started.
 *
 * The Stripe customer id is deliberately not cleared: see the webhook test in
 * delete-user-pii-scrub.test.ts.
 */
export function guardedAccountScrubSql(userId: number, withMarker: boolean): Prisma.Sql {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new Error(`Refusing to build an account scrub for user id ${String(userId)}`);
  const id = Prisma.raw(`${userId}::int`);
  const statement = Prisma.sql`DO $guard$
DECLARE scrubbed integer;
BEGIN
  UPDATE "User"
  SET "deletedAt" = now(),
      email = NULL,
      username = NULL,
      name = NULL,
      "paddleCustomerId" = NULL,
      image = NULL,
      "profilePictureId" = NULL,
      "subscriptionId" = NULL
  WHERE id = ${id} AND NOT ${accountHoldSql(id, withMarker)};
  GET DIAGNOSTICS scrubbed = ROW_COUNT;
  IF scrubbed = 0 THEN
    RAISE EXCEPTION USING ERRCODE = ${abortCode}, MESSAGE = 'account scrub changed no row';
  END IF;
END
$guard$`;
  if (statement.values.length)
    throw new Error('The guarded account scrub must carry no parameters');
  return statement;
}

/**
 * Whether a failed transaction was stopped by the guarded scrub, or failed on the marker view it
 * names (dropped between the check and the scrub). Both count as held, and neither error may reach
 * the user: the second names the view.
 */
export function isLegalHoldAbort(e: unknown): boolean {
  const err = e as {
    code?: unknown;
    meta?: { code?: unknown; message?: unknown };
    message?: unknown;
  } | null;
  if (err?.meta?.code === HOLD_ABORT_CODE || err?.code === HOLD_ABORT_CODE) return true;
  const text = [err?.message, err?.meta?.message].filter((m) => typeof m === 'string').join('\n');
  return text.includes(HOLD_ABORT_CODE) || text.includes(`"${HOLD_MARKER_VIEW}"`);
}
