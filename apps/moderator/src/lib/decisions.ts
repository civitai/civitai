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
