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
  return download > 0 || generation > 0;
}

/**
 * The same rule as SQL, for the queries that page and count rather than fetch rows —
 * `isSaleEligibleGate` cannot filter a list the caller has not loaded.
 *
 * `jsonb_typeof(...) = 'number'` guards the cast rather than decorating it: `->>'price'` on a string or
 * an object is still text, and `::numeric` over that hard-errors the whole batch instead of skipping the
 * row. `numeric` rather than `int` for the same reason — the write path has never rejected a fractional
 * price.
 */
export function saleEligibleSqlText(alias: string): string {
  const priced = (tier: 'download' | 'generation') =>
    `(jsonb_typeof(pa."terms"->'${tier}'->'price') = 'number' and (pa."terms"->'${tier}'->>'price')::numeric > 0)`;
  return `exists (
    select 1 from "PaidAccess" pa
    where pa."entityType" = 'ModelVersion'
      and pa."entityId" = ${alias}."id"
      and pa."timeframeDays" is null
      and (pa."endsAt" is null or pa."endsAt" > now())
      and (${priced('download')} or ${priced('generation')})
  )`;
}

export function saleEligibleFilter(alias: string) {
  return sql.raw<boolean>(saleEligibleSqlText(alias));
}
