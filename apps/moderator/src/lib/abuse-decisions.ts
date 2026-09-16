import type { AbuseVerdict } from './abuse-verdicts';

/**
 * Collapsing a run's findings into the DECISIONS a moderator actually makes.
 *
 * 🔴 IN `$lib` RATHER THAN INSIDE `+page.svelte`, AND THAT IS THE POINT. This app has no component
 * render harness — `routes/abuse/__tests__/load-status.test.ts` says so in as many words — so logic
 * written inside a `$derived` is logic nothing can assert. The grouping rule is the substance of the
 * feature: get it wrong and a ring of eleven renders as one row that rules one account, or as eleven
 * rows that each rule all eleven. Neither is visible to a type checker and neither would fail a
 * source-level grep. A pure function is testable as one.
 */

/** The finding fields this module reads. Structural, so both the page's row type and a test fixture
 *  satisfy it without either importing the other's shape. */
export type GroupableFinding = {
  id: number;
  actioned: boolean;
  confidence: number;
  groupKey: string | null;
  verdict: AbuseVerdict | null;
};

export type Decision<F extends GroupableFinding> = {
  /**
   * Stable `{#each}` key.
   *
   * 🔴 TWO NAMESPACES, NOT ONE. A producer's group key is an opaque string it chose; keying an
   * ungrouped finding on its bare id would let a producer that emitted the key `"7"` collapse into
   * the finding whose id is 7. The prefixes make that unrepresentable rather than unlikely.
   */
  id: string;
  groupKey: string | null;
  /** Every finding this one decision covers — one element for an ungrouped finding. */
  members: F[];
  /** The row rendered: the most-confident member, matching the order the run is sorted in. */
  lead: F;
};

/**
 * One decision per cluster, and one per ungrouped finding.
 *
 * 🔴 A NULL `groupKey` IS THE ABSENCE OF A GROUP, NEVER A GROUP OF ITS OWN. Bucketing on the raw
 * value would sweep every ungrouped finding in the run into a single row — and because that row
 * would render plausibly, with a count and a list of members, the failure would read as the feature
 * working. Each such finding therefore gets a bucket keyed on its own id.
 *
 * Ordering is the page's existing rule, applied at both levels: acted-on first (the rows with
 * consequences lead), then by the producer's confidence. Applied WITHIN a cluster too, because that
 * is what picks the lead, and a lead chosen by input order would change which reason a moderator
 * reads when the service's sort changed.
 */
export function groupFindings<F extends GroupableFinding>(findings: readonly F[]): Decision<F>[] {
  const byKey = new Map<string, F[]>();
  for (const f of findings) {
    const id = f.groupKey === null ? `finding:${f.id}` : `group:${f.groupKey}`;
    const bucket = byKey.get(id);
    if (bucket) bucket.push(f);
    else byKey.set(id, [f]);
  }

  return [...byKey.entries()]
    .map(([id, members]) => {
      const sorted = [...members].sort(byConsequenceThenConfidence);
      return { id, groupKey: sorted[0].groupKey, members: sorted, lead: sorted[0] };
    })
    .sort((a, b) => byConsequenceThenConfidence(a.lead, b.lead));
}

const byConsequenceThenConfidence = (a: GroupableFinding, b: GroupableFinding) =>
  Number(b.actioned) - Number(a.actioned) || b.confidence - a.confidence;

/**
 * The stored ruling for a decision, or `'mixed'`.
 *
 * 🔴 `mixed` IS A REAL STATE AND IS REPORTED AS ONE. A cluster whose members were ruled individually
 * — before the producer started grouping them, or by a ruling that predates the key — can genuinely
 * disagree. Collapsing that to the lead's verdict would present one member's ruling as the whole
 * cluster's, which is the board asserting something no human said.
 */
export function storedVerdict(d: Decision<GroupableFinding>): AbuseVerdict | 'mixed' | null {
  const distinct = new Set(d.members.map((m) => m.verdict));
  return distinct.size > 1 ? 'mixed' : d.members[0].verdict;
}
