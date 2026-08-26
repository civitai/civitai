import { sql } from '@civitai/db/kysely';
import {
  gatePrices,
  maxSaleDays,
  maxSaleLeadDays,
  saleDaysUsed,
  type ModelVersionSaleWindow,
  type ModelVersionTerms,
  type SaleLimitOverrides,
} from '@civitai/buzz';
import { dbRead, dbWrite } from '$lib/server/db';
import { classifyGate } from '$lib/server/monetization/sale-eligibility';
import { saleLengthInDays } from '$lib/monetization/sales';

/** One selected version the creator owns, with everything the eligibility rule and the floor need. */
type EligibleVersion = {
  id: number;
  baseModel: string | null;
  timeframeDays: number | null;
  endsAt: Date | null;
  terms: unknown;
};

// Scheduled sales — server reads and every write that changes a sale. Spec: CU 868ktk1ku.
//
// Written straight to the shared DB with kysely and followed by `bustVersionCache`, the same shape as
// licensing fee and usage control: a sale row has none of the side effects (donation goals, buzz
// bookkeeping, publish guards) that force paid access through the main app's REST endpoint.
//
// Every rule here is enforced on the PRIMARY, inside the statement or transaction that acts on it. The
// form checks the same rules, but only so the creator gets told before submitting — a client-side bound
// is a hint, and every one of these is reachable by a forged POST.

/** How far back sales are loaded for the budget. Two months covers this month and the lead into next. */
const BUDGET_LOOKBACK_MONTHS = 2;

/**
 * Advisory-lock namespace for the per-creator sale budget. Serialises budget arithmetic per creator:
 * READ COMMITTED lets two concurrent submissions each read a budget the other is about to spend, and
 * there is no row to lock for a creator's first sale of the month, so a row lock cannot help.
 */
const SALE_BUDGET_LOCK_CLASS = 4109;

/**
 * What the sale form needs about a selection it can't see: how much of it a sale would actually cover,
 * and why the rest is out. Same classification the write applies, so the form cannot offer a sale the
 * write is going to refuse.
 */
export async function summarizeSaleSelection(
  userId: number,
  versionIds: number[]
): Promise<{
  eligible: number;
  earlyAccess: number;
  unpriced: number;
  minCoveredPrice: number | null;
}> {
  if (!versionIds.length)
    return { eligible: 0, earlyAccess: 0, unpriced: 0, minCoveredPrice: null };
  const { eligible, skippedEarlyAccess, skippedUnpriced } = await classifySelection(
    dbRead,
    userId,
    versionIds
  );
  return {
    eligible: eligible.length,
    earlyAccess: skippedEarlyAccess,
    unpriced: skippedUnpriced,
    minCoveredPrice: lowestBuyerPrice(eligible),
  };
}

/**
 * The floor a Fixed discount must stay under: the cheapest price a BUYER would actually be charged
 * across the versions a sale WOULD cover.
 *
 * Both chargeable prices count, since a sale discounts the download price and any separate generation
 * price alike.
 *
 * 🔴 Measured over the ELIGIBLE rows, not over every permanent gate in the selection. A second query
 * with its own idea of "covered" is how the floor comes to be priced against a version the sale does
 * not cover — it already had no `endsAt` test while eligibility did.
 */
function lowestBuyerPrice(rows: EligibleVersion[]): number | null {
  let lowest: number | null = null;
  for (const row of rows) {
    const { download, generation } = gatePrices(row.terms as ModelVersionTerms | null);
    for (const stored of [download, generation]) {
      // The stored price IS the buyer-facing one.
      if (stored > 0 && (lowest === null || stored < lowest)) lowest = stored;
    }
  }
  return lowest;
}

/** The creator's recent sales, for the budget hint. Windows only — never a resolved price. */
export async function getCreatorSales(userId: number): Promise<ModelVersionSaleWindow[]> {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCMonth(since.getUTCMonth() - (BUDGET_LOOKBACK_MONTHS - 1));

  return await dbRead
    .selectFrom('ModelVersionSale')
    .select(['id', 'discountType', 'discountAmount', 'startsAt', 'endsAt', 'canceledAt'])
    .where('userId', '=', userId)
    .where('startsAt', '>=', since)
    .execute();
}

export type ScheduleSaleInput = {
  name?: string;
  discountType: 'Fixed' | 'Percent';
  discountAmount: number;
  startsAt: Date;
  endsAt: Date;
};

export type ScheduleSaleResult =
  | {
      ok: true;
      saleId: number;
      covered: number;
      skippedEarlyAccess: number;
      skippedUnpriced: number;
      versionIds: number[];
    }
  | { ok: false; error: string };

/** UTC midnight today — the earliest a sale may start. */
function startOfTodayUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Schedules one sale over the eligible versions of a selection.
 *
 * 🔴 The window bounds, the zero-floor and the budget are all checked HERE, not only in the form. A
 * forged POST is the threat model for each: a start six months out breaks the lead rule, and a
 * BACKDATED start is worse than it looks — `saleDaysUsed` buckets strictly by start month, so one
 * backdated sale per past month yields arbitrarily many concurrent sale-days out of untouched budgets.
 *
 * 🔴 An advisory lock, not just a transaction. The transaction closes the replica-lag hole (a `dbRead`
 * pre-check would authorise against a replica while the insert lands on the primary), but READ
 * COMMITTED still lets two submissions — two tabs, or a double-click — read `used = 0` and both insert.
 * The lock serialises the read-decide-insert per creator; there is no row to lock for their first sale.
 */
export async function scheduleSale(
  userId: number,
  versionIds: number[],
  tier: string | null,
  input: ScheduleSaleInput,
  overrides?: SaleLimitOverrides,
  now: Date = new Date()
): Promise<ScheduleSaleResult> {
  const draftDays = saleLengthInDays(input.startsAt, input.endsAt);
  if (draftDays <= 0) return { ok: false, error: 'A sale needs a start and an end date.' };

  if (input.startsAt < startOfTodayUtc(now))
    return { ok: false, error: "A sale can't start in the past." };

  const leadDays = (input.startsAt.getTime() - now.getTime()) / 86_400_000;
  const maxLead = maxSaleLeadDays(overrides);
  if (leadDays > maxLead)
    return { ok: false, error: `A sale can start at most ${maxLead} days from now.` };

  return await dbWrite.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${SALE_BUDGET_LOCK_CLASS}, ${userId})`.execute(trx);

    // Ownership and eligibility resolved on the primary too: a version that just changed hands or just
    // took an early-access gate must not slip in behind a stale replica.
    const { eligible, skippedEarlyAccess, skippedUnpriced } = await classifySelection(
      trx,
      userId,
      versionIds
    );
    if (!eligible.length)
      return {
        ok: false as const,
        // Three arms, matching resolveSaleEligibility's. Reachable only by a forged POST or by the
        // selection changing between preview and submit — but a refusal that names the wrong reason is
        // worse than the generic one, and the client already had the mixed case.
        error:
          skippedUnpriced > 0 && skippedEarlyAccess > 0
            ? 'None of the selected versions can go on sale — some are in early access, and the rest have no permanent access price.'
            : skippedUnpriced > 0
              ? 'None of the selected versions can go on sale — a sale discounts a permanent access price, and none of them has one.'
              : "None of the selected versions can go on sale — a sale can't run on early access.",
      };

    const refusal = await zeroFloorRefusal(trx, userId, eligible.map((v) => v.id), {
      discountType: input.discountType,
      discountAmount: input.discountAmount,
    });
    if (refusal) return { ok: false as const, error: refusal };

    const month = new Date(
      Date.UTC(input.startsAt.getUTCFullYear(), input.startsAt.getUTCMonth(), 1)
    );
    const existing = await salesInMonth(trx, userId, month);
    const used = saleDaysUsed(existing, month);
    const allowed = maxSaleDays(tier, overrides);
    if (used + draftDays > allowed)
      return {
        ok: false as const,
        error: `That sale is ${draftDays} days, and you have ${Math.max(
          0,
          allowed - used
        )} of ${allowed} sale-days left for that month.`,
      };

    const sale = await trx
      .insertInto('ModelVersionSale')
      .values({
        userId,
        name: input.name || null,
        discountType: input.discountType,
        discountAmount: input.discountAmount,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        // Prisma's @updatedAt is applied by the Prisma client, not by a column default — a kysely
        // insert has to set it or the NOT NULL column rejects the row.
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('ModelVersionSaleItem')
      .values(eligible.map((v) => ({ saleId: sale.id, modelVersionId: v.id })))
      .execute();

    return {
      ok: true as const,
      saleId: sale.id,
      covered: eligible.length,
      skippedEarlyAccess,
      skippedUnpriced,
      // Returned rather than re-read after the commit: these are the rows just written, and a fresh
      // lookup for the cache bust is a replica read that can come back empty.
      versionIds: eligible.map((v) => v.id),
    };
  });
}

/**
 * The reason a discount would take a covered version to zero, or null when it wouldn't.
 *
 * Shared by scheduling and deepening because deepening is the operation that walks a legal sale into an
 * illegal one — checking it only at schedule time leaves `?/deepenSale` as a way to reach 100% off.
 */
async function zeroFloorRefusal(
  trx: typeof dbWrite,
  userId: number,
  versionIds: number[],
  discount: { discountType: 'Fixed' | 'Percent'; discountAmount: number }
): Promise<string | null> {
  if (discount.discountType === 'Percent')
    return discount.discountAmount >= 100 ? 'A sale can take at most 99% off.' : null;

  // No ids means we cannot price a floor, which is not the same as there being none to clear.
  if (!versionIds.length) return 'Could not check the prices on this sale. Try again.';

  const { eligible } = await classifySelection(trx, userId, versionIds);
  const floor = lowestBuyerPrice(eligible);
  if (floor === null || discount.discountAmount < floor) return null;
  return `That discount would take the cheapest covered version (${floor} Buzz) to zero. Lower it, or clear the gate to give the model away.`;
}

export type SaleEditResult = { ok: true; versionIds: number[] } | { ok: false; error: string };

/**
 * Ends a sale now.
 *
 * `canceledAt = now` is what returns the untaken tail to the budget: `saleDaysCharged` bills up to the
 * cancellation, so cancelling before it starts costs nothing and cancelling on day 2 of 7 returns 5.
 * Idempotent — a second cancel reports a refusal rather than moving the date earlier.
 */
export async function cancelSale(userId: number, saleId: number): Promise<SaleEditResult> {
  const now = new Date();
  const versionIds = await versionIdsForSale(saleId, dbWrite);
  const res = await dbWrite
    .updateTable('ModelVersionSale')
    .set({ canceledAt: now, updatedAt: now })
    .where('id', '=', saleId)
    // Ownership in the WHERE, not a prior read: a check-then-write on the replica is how one creator
    // ends another's sale during lag.
    .where('userId', '=', userId)
    .where('canceledAt', 'is', null)
    .executeTakeFirst();

  if (!Number(res.numUpdatedRows)) return { ok: false, error: 'That sale is already cancelled.' };
  return { ok: true, versionIds };
}

/**
 * Moves a sale's end EARLIER. Never later — a running sale may only get smaller or cheaper.
 *
 * 🔴 Three bounds, not one. `endsAt > :new` alone lets the new end land at or before `startsAt`, or in
 * the past, and `saleDaysCharged` bills `endsAt - startsAt` for an uncancelled sale — so shrinking a
 * finished 30-day sale to 1 day REFUNDS 29 days that were actually served, and the creator can spend
 * them again. Ending a sale that has already begun is what `cancelSale` is for; it bills the days run.
 *
 * All three live in the UPDATE's own WHERE clause: a read-then-write against the replica would let a
 * stale `endsAt` pass an extension off as a shortening.
 */
export async function shortenSale(
  userId: number,
  saleId: number,
  endsAt: Date,
  now: Date = new Date()
): Promise<SaleEditResult> {
  const versionIds = await versionIdsForSale(saleId, dbWrite);
  const res = await dbWrite
    .updateTable('ModelVersionSale')
    .set({ endsAt, updatedAt: new Date() })
    .where('id', '=', saleId)
    .where('userId', '=', userId)
    .where('canceledAt', 'is', null)
    // Strictly earlier than it ends today — otherwise this is not a shortening.
    .where('endsAt', '>', endsAt)
    // 🔴 The new end must be past BOTH the start and this moment. `endsAt > now` on the column only says
    // the sale hasn't finished; it says nothing about where the new end lands. Without this, a sale that
    // ran Aug 1-31 can be moved to end Aug 2 on Aug 20, and `saleDaysCharged` then bills 2 days for a
    // discount that ran 19 — 28 days handed back to a budget that is supposed to bound spending. No UI
    // does that; a POST does.
    .where(sql<boolean>`greatest("startsAt", ${now}::timestamp) < ${endsAt}::timestamp`)
    .executeTakeFirst();

  if (!Number(res.numUpdatedRows))
    return {
      ok: false,
      error:
        "Pick a day before the sale's current last day, and not one that has already passed. To stop a running sale, end it instead.",
    };
  return { ok: true, versionIds };
}

/**
 * Deepens a sale's discount, keeping its type. Shallower is refused in the WHERE clause; the zero-floor
 * is re-checked here because deepening is exactly how a legal sale becomes one that charges nothing.
 */
export async function deepenSale(
  userId: number,
  saleId: number,
  discountAmount: number
): Promise<SaleEditResult> {
  return await dbWrite.transaction().execute(async (trx) => {
    // Inside the transaction and on the primary: the zero-floor is measured over these ids, and a
    // replica read here can return [] — which would price the floor against nothing and wave through a
    // discount that takes every covered version to the 1-Buzz backstop.
    const versionIds = await versionIdsForSale(saleId, trx);
    const sale = await trx
      .selectFrom('ModelVersionSale')
      .select(['discountType'])
      .where('id', '=', saleId)
      .where('userId', '=', userId)
      .where('canceledAt', 'is', null)
      .executeTakeFirst();
    if (!sale) return { ok: false as const, error: 'That sale is no longer editable.' };

    const refusal = await zeroFloorRefusal(trx, userId, versionIds, {
      discountType: sale.discountType,
      discountAmount,
    });
    if (refusal) return { ok: false as const, error: refusal };

    const res = await trx
      .updateTable('ModelVersionSale')
      .set({ discountAmount, updatedAt: new Date() })
      .where('id', '=', saleId)
      .where('userId', '=', userId)
      .where('canceledAt', 'is', null)
      .where('discountAmount', '<', discountAmount)
      .executeTakeFirst();

    if (!Number(res.numUpdatedRows))
      return { ok: false as const, error: "A running sale's discount can only get deeper." };
    return { ok: true as const, versionIds };
  });
}

/**
 * Splits a selection into the versions a sale can actually discount and the reasons the rest can't.
 *
 * A version with no permanent access price used to be eligible, on the reasoning that a sale over it
 * simply discounts nothing until the creator prices it. That is the bug in CU 868kwp6cx: the sale is
 * created, reports itself as covering the version, and then shows nothing on the card, the model page
 * or the charge — because there is no price for `discountedTerms` to compose over. Every one of the 13
 * sale items in production on 2026-08-25 was in that state.
 *
 * Versions the creator does not own are absent from the rows and silently dropped, as before.
 */
async function classifySelection(
  trx: typeof dbRead | typeof dbWrite,
  userId: number,
  versionIds: number[]
): Promise<{
  eligible: EligibleVersion[];
  skippedEarlyAccess: number;
  skippedUnpriced: number;
}> {
  const rows = await trx
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .leftJoin('PaidAccess as pa', (join) =>
      join.onRef('pa.entityId', '=', 'mv.id').on('pa.entityType', '=', 'ModelVersion')
    )
    .select(['mv.id', 'mv.baseModel', 'pa.timeframeDays', 'pa.endsAt', 'pa.terms'])
    .where('mv.id', 'in', versionIds)
    .where('m.userId', '=', userId)
    .execute();

  const eligible: EligibleVersion[] = [];
  let skippedEarlyAccess = 0;
  let skippedUnpriced = 0;
  for (const row of rows) {
    // A LEFT JOIN miss and a permanent gate both leave `timeframeDays` null, so the row is only a gate
    // when `terms` came back — otherwise every ungated version reads as permanent.
    const verdict = classifyGate(row.terms == null ? null : row);
    if (verdict === 'eligible') eligible.push(row);
    else if (verdict === 'earlyAccess') skippedEarlyAccess++;
    else skippedUnpriced++;
  }
  return { eligible, skippedEarlyAccess, skippedUnpriced };
}

async function salesInMonth(
  trx: typeof dbWrite,
  userId: number,
  month: Date
): Promise<ModelVersionSaleWindow[]> {
  const nextMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
  return await trx
    .selectFrom('ModelVersionSale')
    .select(['id', 'discountType', 'discountAmount', 'startsAt', 'endsAt', 'canceledAt'])
    .where('userId', '=', userId)
    .where('startsAt', '>=', month)
    .where('startsAt', '<', nextMonth)
    .execute();
}

/**
 * Live-or-upcoming sale windows for the given versions, keyed by version id. Scoped to the page's own
 * versions rather than the whole catalogue: a creator who has bulk-scheduled across hundreds of versions
 * would otherwise pull every item row to render one editor.
 *
 * Finished sales are left out on purpose — the price editor warns about a sale a new base price would
 * still feed, and a window that has already closed can't be fed by anything.
 */
export async function getSalesByVersion(
  userId: number,
  versionIds: number[],
  now: Date = new Date()
): Promise<Record<number, ModelVersionSaleWindow[]>> {
  if (!versionIds.length) return {};
  const rows = await dbRead
    .selectFrom('ModelVersionSaleItem as i')
    .innerJoin('ModelVersionSale as s', 's.id', 'i.saleId')
    .select([
      'i.modelVersionId',
      's.id',
      's.discountType',
      's.discountAmount',
      's.startsAt',
      's.endsAt',
      's.canceledAt',
    ])
    .where('i.modelVersionId', 'in', versionIds)
    .where('s.userId', '=', userId)
    .where('s.endsAt', '>', now)
    .where('s.canceledAt', 'is', null)
    .execute();

  const byVersion: Record<number, ModelVersionSaleWindow[]> = {};
  for (const r of rows) {
    (byVersion[r.modelVersionId] ??= []).push({
      id: r.id,
      discountType: r.discountType,
      discountAmount: r.discountAmount,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      canceledAt: r.canceledAt,
    });
  }
  return byVersion;
}

export type SaleVersion = { id: number; modelName: string; versionName: string };

/**
 * The versions each sale covers, keyed by sale id. Loaded with the sales rather than on demand: a creator
 * opening a sale wants to see what is in it, and that is one join over a set already bounded by the
 * creator's own live-or-upcoming sales.
 */
export async function getSaleVersionsBySale(
  userId: number,
  saleIds: number[]
): Promise<Record<number, SaleVersion[]>> {
  if (!saleIds.length) return {};
  const rows = await dbRead
    .selectFrom('ModelVersionSaleItem as i')
    .innerJoin('ModelVersionSale as s', 's.id', 'i.saleId')
    .innerJoin('ModelVersion as mv', 'mv.id', 'i.modelVersionId')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .select(['i.saleId', 'mv.id as versionId', 'mv.name as versionName', 'm.name as modelName'])
    .where('i.saleId', 'in', saleIds)
    // Scoped to the caller even though the ids came from their own sales: an id list is not authorisation.
    .where('s.userId', '=', userId)
    .orderBy('m.name')
    .execute();

  const bySale: Record<number, SaleVersion[]> = {};
  for (const r of rows) {
    (bySale[r.saleId] ??= []).push({
      id: r.versionId,
      modelName: r.modelName,
      versionName: r.versionName,
    });
  }
  return bySale;
}

/** Sales the creator can still act on, with how many versions each covers. */
export async function getManageableSales(
  userId: number,
  now: Date = new Date()
): Promise<(ModelVersionSaleWindow & { name: string | null; versionCount: number })[]> {
  const rows = await dbRead
    .selectFrom('ModelVersionSale as s')
    .leftJoin('ModelVersionSaleItem as i', 'i.saleId', 's.id')
    .select(({ fn }) => [
      's.id',
      's.name',
      's.discountType',
      's.discountAmount',
      's.startsAt',
      's.endsAt',
      's.canceledAt',
      fn.count<string>('i.modelVersionId').as('versionCount'),
    ])
    .where('s.userId', '=', userId)
    .where('s.endsAt', '>', now)
    .where('s.canceledAt', 'is', null)
    .groupBy([
      's.id',
      's.name',
      's.discountType',
      's.discountAmount',
      's.startsAt',
      's.endsAt',
      's.canceledAt',
    ])
    .orderBy('s.startsAt')
    .execute();

  return rows.map((r) => ({ ...r, versionCount: Number(r.versionCount) }));
}

/**
 * Versions a sale covers — what the cache bust has to reach after any write that changes it.
 *
 * 🔴 Defaults to the PRIMARY. Every caller runs microseconds after its own commit, and a replica read
 * there can return [] — at which point `bustVersionCache` early-returns and the sale is invisible on
 * site until the cache TTL lapses.
 */
export async function versionIdsForSale(
  saleId: number,
  db: typeof dbRead | typeof dbWrite = dbWrite
): Promise<number[]> {
  const rows = await db
    .selectFrom('ModelVersionSaleItem')
    .select('modelVersionId')
    .where('saleId', '=', saleId)
    .execute();
  return rows.map((r) => r.modelVersionId);
}
