import { sql } from '@civitai/db/kysely';
import { gatePrices, isPaidAccessActive, isPermanentGate } from '@civitai/buzz';
import type { ModelVersionTerms } from '@civitai/buzz';

// What a sale can actually discount. One definition, read by the picker's filter, by the sale form's
// preview and by the schedule write, because the three disagreeing is the bug this exists to close:
// eligibility used to mean "owned and not early access", so a version with no price at all was
// selectable, schedulable, and then discounted nothing. All 13 sale items in production on 2026-08-25
// covered a version in exactly that state (CU 868kwp6cx).

type EligibleRow = {
  timeframeDays: number | null;
  endsAt: Date | null;
  terms: unknown;
};

/** Why a selected version is not covered — the two reasons a creator is told apart. */
export type GateVerdict = 'eligible' | 'earlyAccess' | 'unpriced';

const isPositivePrice = (price: unknown): boolean => typeof price === 'number' && price > 0;

/**
 * True when a sale laid over this gate would take Buzz off something.
 *
 * Permanent only — a sale never covers a timed early-access window, and the main app re-checks the same
 * rule when it prices, since the gate type stays mutable after a sale exists. Priced only —
 * `discountedTerms` composes over the download and generation prices and nothing else, so a gate
 * carrying neither resolves to no discount on the card, the model page or the charge.
 */
export function isSaleEligibleGate(row: EligibleRow | null | undefined): boolean {
  if (!row) return false;
  if (!isPermanentGate(row) || !isPaidAccessActive(row)) return false;
  const { download, generation } = gatePrices(row.terms as ModelVersionTerms | null);
  // `typeof`, not just `> 0`: `terms` is jsonb the type system says nothing about, and `'500' > 0` is
  // true in JS while the SQL half's `jsonb_typeof` guard calls the same row ineligible. Guarding one
  // side only is how the picker and the write come to disagree about a version.
  return isPositivePrice(download) || isPositivePrice(generation);
}

/**
 * The verdict on one selected version, given its gate row (`null` when it has none).
 *
 * Separate from `isSaleEligibleGate` because the creator is told WHICH reason applies, and the two arms
 * are trivially swappable — the error message and the toast then name the wrong one with every test
 * still green.
 */
export function classifyGate(row: EligibleRow | null | undefined): GateVerdict {
  if (isSaleEligibleGate(row)) return 'eligible';
  return row && row.timeframeDays != null ? 'earlyAccess' : 'unpriced';
}

/**
 * The same rule as SQL, for the queries that page and count rather than fetch rows —
 * `isSaleEligibleGate` cannot filter a list the caller has not loaded.
 *
 * 🔴 Scoped by `ownerId`, which is not redundant with the caller's own `Model.userId` join. Without it
 * the planner reads the subquery as the cheap driver, scans every permanent priced gate on the site and
 * PK-probes its way back — measured on production at 41.9 ms / 29,985 buffers for a creator with no
 * gates at all, against 0.28 ms / ~46 buffers with the clause, and it grows with the table rather than
 * with the creator. `PaidAccess.ownerId` and `Model.userId` agree on all 5,071 production rows, and the
 * ownership-transfer path maintains both.
 *
 * `jsonb_typeof(...) = 'number'` guards the cast rather than decorating it: `->>'price'` on a string or
 * an object is still text, and `::numeric` over that hard-errors the whole batch instead of skipping the
 * row. `numeric` rather than `int` for the same reason — the write path has never rejected a fractional
 * price.
 *
 * The `'free'` test mirrors `gatePrices`, which drops the generation tier wholesale when the grant is a
 * free one. Without it a `{ free: true, price: N }` row is eligible here and ineligible in JS.
 */
export function saleEligibleSqlText(alias: string, userId: number): string {
  // This is `sql.raw`, so nothing downstream parameterises `userId`. Refuse rather than interpolate
  // anything that is not an integer.
  if (!Number.isInteger(userId)) throw new Error('saleEligibleSqlText: userId must be an integer');
  const priced = (tier: 'download' | 'generation') =>
    `(jsonb_typeof(pa."terms"->'${tier}'->'price') = 'number' and (pa."terms"->'${tier}'->>'price')::numeric > 0)`;
  return `exists (select 1 from "PaidAccess" pa where pa."entityType" = 'ModelVersion' and pa."entityId" = ${alias}."id" and pa."ownerId" = ${userId} and pa."timeframeDays" is null and (pa."endsAt" is null or pa."endsAt" > now()) and (${priced(
    'download'
  )} or (not (pa."terms"->'generation' ? 'free') and ${priced('generation')})))`;
}

export function saleEligibleFilter(alias: string, userId: number) {
  return sql.raw<boolean>(saleEligibleSqlText(alias, userId));
}
