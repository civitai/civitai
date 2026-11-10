/**
 * How the review surfaces state an agentic code-review report: its FINDING COUNTS by severity
 * ("AI: 1 high · 2 medium"), coloured by the worst severity present — never a verdict.
 *
 * 🔴 NO SYNTHESIZED VERDICT (operator decision, 2026-11-08). The runner emits findings, not a
 * judgement, and a green "pass" beside a one-click "Approve & next" reads as the AI signing the
 * submission off. So these surfaces count what the report found and say so in plain numbers;
 * zero findings reads "no findings". The word "pass" is never produced.
 *
 * Shared by the queue row chip (computed server-side from a compact summary in
 * `listPendingRequests`) and the review page's Overview card (from the full report), so the
 * two always state the same counts. Pure, React-free and server-free.
 */

export type AgentReviewSummary = {
  /** The report row's lifecycle status. */
  status: string;
  /** Lower-cased severities of every code-review + security-audit finding. */
  severities: string[];
  overBroad: number;
  underDeclared: number;
  /** Scopes whose justification the agent marked inaccurate (`justificationAccurate: 'no'`). */
  inaccurate: number;
};

/** Severity buckets, worst first — the order the counts are written in. */
export const AGENT_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type AgentFindingSeverity = (typeof AGENT_FINDING_SEVERITIES)[number] | 'unrated';

export type AgentFindingCounts = Record<AgentFindingSeverity, number>;

/**
 * `not-run` — no report (or one torn down before it finished); `running` — in flight;
 * `failed` — the RUN failed (not a finding); `reported` — a finished (or cost-capped) report,
 * whose counts are the content.
 */
export type AgentReviewState = 'not-run' | 'running' | 'failed' | 'reported';

export type AgentReviewDisplay = {
  state: AgentReviewState;
  /** Full label, e.g. "AI: 1 high · 2 medium", "AI: no findings", "AI: not run". */
  label: string;
  /** The label without the "AI: " prefix, for surfaces already titled "AI review". */
  shortLabel: string;
  color: string;
  /** The worst severity present, or null (none, or not a finished report). */
  worst: AgentFindingSeverity | null;
  counts: AgentFindingCounts;
  /** Over-broad + under-declared + weakly justified scopes, from the scope trace. */
  scopeFlags: number;
};

const SEVERITY_COLORS: Record<AgentFindingSeverity, string> = {
  critical: 'red',
  high: 'red',
  medium: 'orange',
  low: 'yellow',
  info: 'gray',
  unrated: 'gray',
};

function bucket(severity: string): AgentFindingSeverity {
  const s = severity.toLowerCase();
  if (s === 'moderate') return 'medium';
  return (AGENT_FINDING_SEVERITIES as readonly string[]).includes(s)
    ? (s as AgentFindingSeverity)
    : 'unrated';
}

function emptyCounts(): AgentFindingCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0, unrated: 0 };
}

export function agentReviewDisplay(
  summary: AgentReviewSummary | null | undefined
): AgentReviewDisplay {
  const counts = emptyCounts();
  const base = (state: AgentReviewState, short: string, color: string): AgentReviewDisplay => ({
    state,
    label: `AI: ${short}`,
    shortLabel: short,
    color,
    worst: null,
    counts,
    scopeFlags: 0,
  });
  if (!summary) return base('not-run', 'not run', 'gray');
  if (summary.status === 'running') return base('running', 'running', 'blue');
  if (summary.status === 'failed') return base('failed', 'run failed', 'orange');
  if (summary.status !== 'complete' && summary.status !== 'cost-capped') {
    // `torn-down` and anything unknown: there is no finished report to read.
    return base('not-run', 'not run', 'gray');
  }

  for (const s of summary.severities) counts[bucket(s)] += 1;
  const scopeFlags = summary.overBroad + summary.underDeclared + summary.inaccurate;
  const order: AgentFindingSeverity[] = [...AGENT_FINDING_SEVERITIES, 'unrated'];
  const parts = order.filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${k}`);
  if (scopeFlags > 0) parts.push(`${scopeFlags} scope flag${scopeFlags === 1 ? '' : 's'}`);
  const worst = order.find((k) => counts[k] > 0) ?? null;
  // Colour = the worst finding. Scope flags alone read as medium (they are review prompts, not
  // a severity the agent assigned). Nothing at all is GRAY — never green: an empty report is
  // the absence of findings, not an endorsement.
  const worstColor = worst ? SEVERITY_COLORS[worst] : null;
  const atLeastMedium = worst === 'critical' || worst === 'high' || worst === 'medium';
  const color =
    worstColor && atLeastMedium
      ? worstColor
      : scopeFlags > 0
      ? SEVERITY_COLORS.medium
      : worstColor ?? 'gray';
  const short = parts.length > 0 ? parts.join(' · ') : 'no findings';
  return {
    state: 'reported',
    label: `AI: ${short}`,
    shortLabel: short,
    color,
    worst,
    counts,
    scopeFlags,
  };
}
