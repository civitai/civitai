// Which access product a buzz purchase paid for — the timed early-access window or the permanent gate.
// Kept out of $lib/server/models-earnings so the rule can be tested without its clickhouse/db imports.

export type AccessKind = 'earlyAccess' | 'permanentAccess' | 'unknown';

// Permanent gates shipped before the ledger learned to name them: between the two instants below EVERY access
// sale was written with the `early-access-` id AND the "Gain early access on model" description, so a
// permanent sale from that window is indistinguishable from a timed one in the row itself.
//
// Lower bound: permanent pay-for-access became purchasable (f4eb83bc4a, authored 2026-07-21T21:49Z). Nothing
// older can be a permanent sale, so it is named outright rather than guessed — that's ~136k of the ~148k
// access sales on record, none of which should go anywhere near the fallback.
//
// Upper bound: the first row observed carrying the permanent description (the `permanent` flag in `details`
// and the id prefix only arrived Aug 5). Deliberately the LATEST candidate — over-marking an hour of
// genuinely-timed rows as ambiguous is harmless, they resolve back to earlyAccess, while under-marking
// silently keeps the bug.
export const PERMANENT_GATE_LAUNCH = '2026-07-21 21:49:45';
export const ACCESS_KIND_CUTOVER = '2026-08-01 17:55:00';

// ClickHouse expression naming the product a `buzzTransactions` access-sale row paid for. Both id prefixes
// exist: rows predating the split are `early-access-` whichever product they were, which is what makes a
// row from the ambiguous window `unknown` rather than early access.
export const accessKindExpression = `multiIf(
    externalTransactionId LIKE 'permanent-access-%', 'permanentAccess',
    description LIKE 'Gain access to model%', 'permanentAccess',
    date < toDateTime('${PERMANENT_GATE_LAUNCH}'), 'earlyAccess',
    date < toDateTime('${ACCESS_KIND_CUTOVER}'), 'unknown',
    'earlyAccess'
  )`;

// Rows from the ambiguous window carry no gate kind, so they're attributed from the gate the version has NOW: a version
// sold permanently today never ran a timed window for the ledger to be describing. The one case this still
// gets wrong is a version whose creator ran early access and later switched it to permanent — its old
// early-access revenue moves into the permanent column. Versions with no gate at all keep the old default.
export function resolveAccessKind(
  kind: AccessKind,
  versionId: number,
  permanentGates: ReadonlySet<number>
): 'earlyAccess' | 'permanentAccess' {
  if (kind !== 'unknown') return kind;
  return permanentGates.has(versionId) ? 'permanentAccess' : 'earlyAccess';
}
