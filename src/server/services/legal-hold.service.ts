import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  PLACEHOLDER_OWNER_ID,
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

/** A hold that landed after the check stopped a wipe part-way: some of it was already deleted. */
export class LegalHoldStoppedError extends LegalHoldError {
  constructor() {
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
  if (e instanceof LegalHoldStoppedError) return LEGAL_HOLD_STOPPED;
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
    // Uncorrelated, so Postgres builds the set once per statement rather than once per row.
    'reported-image': Prisma.sql`((${id}) IN (
      SELECT ri."userId"
      FROM "CsamReport" rr
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(rr.images) = 'array' THEN rr.images ELSE '[]'::jsonb END
      ) re
      JOIN "Image" ri
        ON ri.id = CASE WHEN (re ->> 'id') ~ '^[0-9]{1,18}$' THEN (re ->> 'id')::bigint END
      WHERE ${reportHolds('rr')}
    ))`,
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

/** What an owner is told when a delete of their content is refused. Never says why. */
export const OWNER_CONTENT_KEPT =
  "This can't be removed right now. Contact support if you need it removed.";

/**
 * Whether content owned by `owner` (an int SQL expression) must be kept: the hold the purge jobs read,
 * which includes the placeholder owner, or any account hold. Put it in the DELETE itself, so a hold
 * placed after an earlier check still stops it. Names the marker view, so it needs its migration.
 */
export function ownerHeldSql(owner: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${userUnderLegalHoldSql(owner)} OR ${accountHoldSql(owner, true)})`;
}

/**
 * Whether the owner of the row `from` selects (aliasing its owner as `m."userId"`) is held: `true`
 * when held or when that cannot be read, `false` when not held or when there is no such row.
 */
export async function ownerHeld(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  from: Prisma.Sql
): Promise<boolean> {
  const rows = await db.$queryRaw<{ held: unknown }[]>`SELECT ${ownerHeldSql(
    Prisma.raw('m."userId"')
  )} AS held ${from}`.catch((e: unknown) => {
    logToAxiom({
      type: 'error',
      name: 'content-legal-hold-check-failed',
      message: (e as Error).message,
    }).catch(() => undefined);
    return null;
  });
  if (!rows) return true;
  return rows.some((r) => r.held !== false);
}

/** The refusal for a delete a hold stopped: never names the hold to an owner. */
export function contentKeptError(isModerator: boolean | undefined) {
  return new TRPCError({
    code: 'FORBIDDEN',
    message: isModerator ? LEGAL_HOLD_REFUSAL : OWNER_CONTENT_KEPT,
  });
}

/**
 * Runs a DELETE guarded by `ownerHeldSql` that should remove `expected` rows. Throws the hold refusal
 * when it removed fewer and the owner of the row `ownerFrom` selects is held (see `ownerHeld`), or
 * when it failed on the marker view. Any other error is rethrown. Either way nothing it is part of
 * commits. Returns 'short' when it removed fewer for another reason: the rows were already gone.
 */
export async function deleteUnlessHeld(
  statement: Promise<number>,
  {
    expected,
    isModerator,
    db,
    ownerFrom,
  }: {
    expected: number;
    isModerator: boolean | undefined;
    db: Pick<Prisma.TransactionClient, '$queryRaw'>;
    ownerFrom: Prisma.Sql;
  }
): Promise<'deleted' | 'short'> {
  const removed = await statement.catch((e: unknown) => {
    if (!isLegalHoldAbort(e)) throw e;
    logToAxiom({
      type: 'error',
      name: 'content-legal-hold-check-failed',
      message: (e as Error).message,
    }).catch(() => undefined);
    throw contentKeptError(isModerator);
  });
  if (removed >= expected) return 'deleted';
  if (await ownerHeld(db, ownerFrom)) throw contentKeptError(isModerator);
  return 'short';
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

export type ModelOwnershipReason = 'create' | 'transfer' | 'account-delete' | 'restore';

/**
 * Records `userId` as an owner of every model `where` matches (over `"Model" m`). Run it in the same
 * transaction as the owner write, so the hold reads every owner a model has had.
 */
export function recordModelOwnershipSql({
  where,
  userId,
  reason,
  actorId = null,
}: {
  where: Prisma.Sql;
  userId: number;
  reason: ModelOwnershipReason;
  actorId?: number | null;
}): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "ModelOwnership" ("modelId", "userId", "reason", "actorId")
    SELECT m.id, ${userId}::int, ${reason}, ${actorId}::int FROM "Model" m WHERE ${where}
  `;
}

/**
 * Records the current owner of every model `where` matches (over `"Model" m`) that has no row for that
 * owner yet, as a baseline: a model created before its history began, or before the backfill reached
 * it, still keeps its owner on record when it moves. Run before the owner write.
 */
export function recordCurrentModelOwnersSql(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "ModelOwnership" ("modelId", "userId", "reason")
    SELECT m.id, m."userId", 'baseline' FROM "Model" m
    WHERE ${where}
      AND NOT EXISTS (
        SELECT 1 FROM "ModelOwnership" o WHERE o."modelId" = m.id AND o."userId" = m."userId"
      )
  `;
}

/**
 * Whether the "ModelOwnership" row `ho` is a placeholder row that still holds its model. An account
 * deletion's placeholder holds until the model is restored; then its owner's own holds apply. A
 * backfilled one always holds: who owned the model before it is not fully recorded.
 */
const placeholderRowHoldsSql = Prisma.sql`(ho."userId" = ${Prisma.raw(
  String(PLACEHOLDER_OWNER_ID)
)} AND (ho.reason <> 'account-delete' OR NOT EXISTS (
  SELECT 1 FROM "ModelOwnership" hrs
  WHERE hrs."modelId" = ho."modelId" AND hrs.reason = 'restore' AND hrs.id > ho.id
)))`;

/**
 * Whether a model's data is held: its owner is the placeholder or under an account hold, or so is any
 * owner it had before. A placeholder that an account deletion put there stops holding once the model
 * is restored to an owner; one recorded by the backfill always holds. `modelId` is an int SQL
 * expression. Names "ModelOwnership": without the table the statement fails, and so deletes nothing.
 */
export function modelDataHeldSql(modelId: Prisma.Sql, markerView: boolean): Prisma.Sql {
  const placeholder = Prisma.raw(String(PLACEHOLDER_OWNER_ID));
  return Prisma.sql`(EXISTS (
    SELECT 1 FROM "Model" hm
    WHERE hm.id = ${modelId}
      AND (hm."userId" = ${placeholder} OR ${accountHoldSql(Prisma.raw('hm."userId"'), markerView)})
  ) OR EXISTS (
    SELECT 1 FROM "ModelOwnership" ho
    WHERE ho."modelId" = ${modelId}
      AND (${placeholderRowHoldsSql} OR ${accountHoldSql(Prisma.raw('ho."userId"'), markerView)})
  ))`;
}

/**
 * The ids, among the model ids `modelIds` selects, whose data `modelDataHeldSql` holds, as a query.
 * For a statement over many models: each owner, present or past, is checked once, not once per row.
 */
export function heldModelIdsSql(modelIds: Prisma.Sql, markerView: boolean): Prisma.Sql {
  const placeholder = Prisma.raw(String(PLACEHOLDER_OWNER_ID));
  return Prisma.sql`
    WITH owners AS MATERIALIZED (
      SELECT hm.id AS "modelId", hm."userId" FROM "Model" hm WHERE hm.id IN (${modelIds})
      UNION
      SELECT ho."modelId", ho."userId" FROM "ModelOwnership" ho WHERE ho."modelId" IN (${modelIds})
    ), held_owners AS MATERIALIZED (
      SELECT a."userId" FROM (SELECT DISTINCT "userId" FROM owners) a
      WHERE ${accountHoldSql(Prisma.raw('a."userId"'), markerView)}
    )
    SELECT ow."modelId" FROM owners ow WHERE ow."userId" IN (SELECT "userId" FROM held_owners)
    UNION
    SELECT hm.id FROM "Model" hm WHERE hm.id IN (${modelIds}) AND hm."userId" = ${placeholder}
    UNION
    SELECT ho."modelId" FROM "ModelOwnership" ho
    WHERE ho."modelId" IN (${modelIds}) AND ${placeholderRowHoldsSql}
  `;
}

/**
 * Logs the holds that kept rows a moderator's bulk delete asked for. Best-effort, and the reason
 * goes no further than here. An author with no hold of their own had a row kept for a held reply
 * below it.
 */
export async function logHoldRetained(action: string, userIds: number[]) {
  for (const userId of new Set(userIds)) {
    const hold = await holdOrNull(userId);
    logToAxiom({
      type: 'info',
      name: 'account-legal-hold',
      message:
        hold?.legs.length === 0 ? `${action}: kept for a held reply` : `${action}: rows retained`,
      details: { userId, legs: hold?.legs ?? null },
    });
  }
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
  const id = Prisma.sql`${userId}::int`;
  const legs = holdLegsSql(id);
  const [row] = await dbWrite.$queryRaw<Record<string, unknown>[]>`
    SELECT
      ${Prisma.join(
        Object.entries(legs).map(([name, leg]) => Prisma.sql`${leg} AS ${Prisma.raw(`"${name}"`)}`)
      )},
      to_regclass(${`"${HOLD_MARKER_VIEW}"`}) IS NOT NULL AS "markerView",
      to_regclass(${`"${HOLD_MARKER_TABLE}"`}) IS NOT NULL AS "markerTable"
  `;
  if (!row) throw new Error('Legal hold lookup returned no row');

  // Anything but an explicit `false` counts as held.
  const held = (Object.keys(legs) as AccountHoldLeg[]).filter((leg) => row[leg] !== false);

  // A separate statement: a query naming the view fails to parse on a database that lacks it.
  if (row.markerView === true) {
    const [marker] = await dbWrite.$queryRaw<{ held: unknown }[]>`SELECT ${markerSql(id)} AS held`;
    if (marker?.held !== false) held.push('hold-marker');
    return { legs: held, markerView: true };
  }
  // The table without its view means the view was dropped or renamed: held until it is back.
  if (!(row.markerView === false && row.markerTable === false)) held.push('hold-marker');
  return { legs: held, markerView: false };
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
