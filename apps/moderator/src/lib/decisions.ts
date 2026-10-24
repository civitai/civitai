/**
 * The shape every decision surface in this app renders: one item a moderator rules on, the evidence
 * it covers, and the member that stands for it. `/abuse` builds it from a run's findings
 * (`$lib/abuse-decisions.ts`); `/decisions` builds it from a source's already-grouped items.
 */
export type Decision<M> = {
  /**
   * Stable `{#each}` key. Namespaced by whoever builds it, so two kinds of key from one producer can
   * never collide (see `groupFindings`).
   */
  id: string;
  groupKey: string | null;
  /** Every member this one decision covers — one element for an ungrouped item. */
  members: M[];
  /** The member rendered as the decision's face. */
  lead: M;
};

/**
 * A source's probability as a moderator reads it.
 *
 * 🔴 `null` IS "NEVER MEASURED" AND RENDERS AS AN EM DASH, NEVER "0%". The support router stores 0.0
 * where it made no model call; the adapter turns those into `null`, and this is where that difference
 * reaches the screen. "0%" would present a call that never happened as a confident answer.
 */
export const probabilityLabel = (p: number | null): string =>
  p === null ? '—' : `${Math.round(p * 100)}%`;

/** A same-app link that keeps a pinned `?version=` — only when the page was opened with one, so the
 *  default view keeps following whatever version routed last. */
export const versionedHref = (path: string, version: string | null, overridden: boolean): string =>
  overridden && version ? `${path}?version=${encodeURIComponent(version)}` : path;

const PAYING_TIERS: ReadonlySet<string> = new Set(['gold', 'silver']);

/**
 * A support requester's membership tier and routing priority, each labelled — rendered after the
 * requester on both the ticket page and the group page.
 *
 * 🔴 THE PRIORITY FLAG IS NOT A STATEMENT ABOUT THE REQUESTER'S TIER. The router sets it when the tier
 * is gold/silver OR the ticket's topic is payment-domain, so a free-tier requester with a billing
 * ticket carries it. Rendered bare beside the tier ("free · paying priority") that reads as a
 * contradiction; the reason is named instead. A flag on a non-gold/silver tier can only have come from
 * the topic arm of that rule — if the router's rule changes, this inference must change with it.
 */
export function requesterTierLabel(
  memberTier: string | null,
  payingPriority: boolean
): string | null {
  const parts: string[] = [];
  if (memberTier) parts.push(`tier: ${memberTier}`);
  if (payingPriority) {
    parts.push(
      memberTier && PAYING_TIERS.has(memberTier)
        ? 'priority: paying member'
        : 'priority: payment topic'
    );
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The one ruling a set of members carries, or `'mixed'` when they disagree.
 *
 * 🔴 `mixed` IS A REAL STATE. Members ruled individually can genuinely disagree, and collapsing that to
 * one member's ruling presents it as the whole decision's — the board asserting something no human
 * said. An empty set is `null` (nothing ruled), never `'mixed'`.
 */
export function collapseRulings<R>(rulings: readonly (R | null)[]): R | 'mixed' | null {
  if (rulings.length === 0) return null;
  const distinct = new Set(rulings);
  return distinct.size > 1 ? 'mixed' : rulings[0];
}
