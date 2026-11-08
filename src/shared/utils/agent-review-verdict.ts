/**
 * ONE verdict for an agentic code-review report, shared by the queue row chip (computed
 * server-side from a compact summary in `listPendingRequests`) and the review page's Overview
 * (computed client-side from the full report). Pure, React-free and server-free so both sides
 * import the same rule rather than spelling it twice.
 *
 * 🔴 IT IS A ROLL-UP OF WHAT THE REPORT ALREADY SAYS, NOT A NEW JUDGEMENT. The runner does not
 * emit a verdict field; this reads the findings' severities and the scope trace and buckets them:
 *   - `fail`     — any critical or high finding;
 *   - `concerns` — any medium/moderate finding, any over-broad or under-declared scope, or any
 *                  scope whose justification the agent judged inaccurate;
 *   - `pass`     — none of the above (low / info findings only, or none).
 * The report stays advisory decision-support: a moderator still decides.
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

/**
 * `not-run`   — no report (or one torn down before it finished);
 * `running`   — in flight;
 * `error`     — the run itself failed (distinct from a `fail` VERDICT);
 * `pass` / `concerns` / `fail` — a finished (or cost-capped) report's roll-up.
 */
export type AgentReviewVerdict = 'not-run' | 'running' | 'error' | 'pass' | 'concerns' | 'fail';

export function agentReviewVerdict(
  summary: AgentReviewSummary | null | undefined
): AgentReviewVerdict {
  if (!summary) return 'not-run';
  switch (summary.status) {
    case 'running':
      return 'running';
    case 'failed':
      return 'error';
    case 'complete':
    case 'cost-capped':
      break;
    default:
      // `torn-down` and anything unknown: there is no finished report to read.
      return 'not-run';
  }
  const sev = summary.severities.map((s) => s.toLowerCase());
  if (sev.some((s) => s === 'critical' || s === 'high')) return 'fail';
  if (
    sev.some((s) => s === 'medium' || s === 'moderate') ||
    summary.overBroad > 0 ||
    summary.underDeclared > 0 ||
    summary.inaccurate > 0
  )
    return 'concerns';
  return 'pass';
}

export const AGENT_REVIEW_VERDICT_LABELS: Record<AgentReviewVerdict, string> = {
  'not-run': 'AI: not run',
  running: 'AI: running',
  error: 'AI: run failed',
  pass: 'AI: pass',
  concerns: 'AI: concerns',
  fail: 'AI: fail',
};

export const AGENT_REVIEW_VERDICT_COLORS: Record<AgentReviewVerdict, string> = {
  'not-run': 'gray',
  running: 'blue',
  error: 'orange',
  pass: 'green',
  concerns: 'yellow',
  fail: 'red',
};
