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
  /** Every analysis (code review, security audit, scopes) produced a result rather than an
   *  error. Absent on an older payload, which then never reads as agent-clean. */
  sectionsOk?: boolean;
  /** The impersonation check's record status (`complete` | `failed`), or null when none ran. */
  impersonationCheck?: string | null;
  /** The fingerprint of the listing the impersonation check looked at, as recorded. */
  impersonationFingerprint?: string | null;
  /**
   * `false` only when the live listing still matches that fingerprint (set by the queue, which
   * compares it with the listing as it is now). Absent or `true` → not fast-laned.
   */
  impersonationStale?: boolean;
};

/** The raw per-request row the queue's summary query returns. */
export type AgentReviewQueueRow = {
  status: string;
  severities: (string | null)[] | null;
  overBroad: number | null;
  underDeclared: number | null;
  inaccurate: number | null;
  sectionsOk: boolean | null;
  impersonationCheck: string | null;
  impersonationFingerprint: string | null;
};

/**
 * The queue row → summary. A finding with NO severity is counted as `unrated` — it must still
 * keep the row out of the fast lane, not drop out of the count.
 */
export function agentReviewSummaryFromQueueRow(row: AgentReviewQueueRow): AgentReviewSummary {
  return {
    status: row.status,
    severities: (row.severities ?? []).map((x) =>
      typeof x === 'string' && x.trim() ? x : 'unrated'
    ),
    overBroad: row.overBroad ?? 0,
    underDeclared: row.underDeclared ?? 0,
    inaccurate: row.inaccurate ?? 0,
    sectionsOk: row.sectionsOk === true,
    impersonationCheck: row.impersonationCheck ?? null,
    impersonationFingerprint: row.impersonationFingerprint ?? null,
  };
}

/** Only a present fingerprint equal to the live listing's is fresh. */
export function isImpersonationCheckStale(
  recorded: string | null | undefined,
  current: string | null | undefined
): boolean {
  return !recorded || !current || recorded !== current;
}

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

/**
 * Where a pending submission sits in the moderator queue, from its agent review.
 *
 * - `agent-clean` — the review finished, every analysis and the impersonation check completed
 *   on the listing as it still is (its fingerprint matches), and nothing was found that needs a
 *   person's judgement first: no finding rated medium or worse (or unrated, or with no
 *   severity), no scope flag. (The row also needs a LIVE review preview — `reviewRowLane`.) These sort to the TOP of the queue. A moderator still
 *   opens and approves every one of them; nothing is approved without a person.
 * - `flagged` — the review finished but found something, or did not complete (a failed or
 *   cost-capped run, a failed analysis, a missing or failed impersonation check). Normal queue,
 *   with the report.
 * - `waiting` — no review yet, or one still running. Normal queue.
 *
 * 🔴 FAIL-CLOSED: anything this function does not positively recognise as clean is not clean.
 */
export type AgentReviewLane = 'agent-clean' | 'flagged' | 'waiting';

export type AgentReviewLaneResult = {
  lane: AgentReviewLane;
  /** Why it is flagged (empty unless `flagged`), in plain words for the badge's tooltip. */
  reasons: string[];
};

const FLAGGING_SEVERITIES: ReadonlySet<AgentFindingSeverity> = new Set([
  'critical',
  'high',
  'medium',
  'unrated',
]);

export function agentReviewLane(
  summary: AgentReviewSummary | null | undefined
): AgentReviewLaneResult {
  const display = agentReviewDisplay(summary);
  if (!summary || display.state === 'not-run' || display.state === 'running') {
    return { lane: 'waiting', reasons: [] };
  }
  const reasons: string[] = [];
  if (display.state === 'failed') reasons.push('the agent review failed');
  if (summary.status === 'cost-capped') reasons.push('the agent review stopped at its cost cap');
  if (display.state === 'reported') {
    if (summary.sectionsOk !== true) reasons.push('an analysis did not complete');
    if (summary.impersonationCheck !== 'complete') {
      reasons.push(
        summary.impersonationCheck === 'failed'
          ? 'the impersonation check did not complete'
          : 'the impersonation check has not run'
      );
    } else if (summary.impersonationStale !== false) {
      reasons.push('the listing changed after the impersonation check: re-run the review');
    }
    const flagging = (Object.keys(display.counts) as AgentFindingSeverity[]).reduce(
      (n, k) => n + (FLAGGING_SEVERITIES.has(k) ? display.counts[k] : 0),
      0
    );
    if (flagging > 0) reasons.push(`${flagging} finding${flagging === 1 ? '' : 's'} to check`);
    if (display.scopeFlags > 0)
      reasons.push(`${display.scopeFlags} scope flag${display.scopeFlags === 1 ? '' : 's'}`);
  }
  return reasons.length > 0 ? { lane: 'flagged', reasons } : { lane: 'agent-clean', reasons };
}

/**
 * The queue badge for a lane — it says what the moderator does next, never a verdict.
 * `waiting` has no badge (the AI chip already says "not run" / "running").
 */
export const AGENT_REVIEW_LANE_BADGES: Record<
  Exclude<AgentReviewLane, 'waiting'>,
  { label: string; color: string }
> = {
  'agent-clean': { label: 'Fast lane: read the report, then decide', color: 'teal' },
  flagged: { label: 'Agent flagged: read the findings first', color: 'orange' },
};

/**
 * The impersonation check on an APPROVED app's listing edit, as the listing queue reads it
 * (`app-listing-edit-impersonation.service`). Absent when the edit changed none of name, icon or
 * cover — nothing was checked and the row looks as it always did.
 */
export type ListingEditCheckSummary = {
  /** `missing` = an identity-changing edit with no stored result at all; `stale` = a complete
   *  result for a revision that has been edited since (its fingerprint no longer matches). */
  status: 'complete' | 'failed' | 'pending' | 'skipped' | 'missing' | 'stale';
  /** Findings rated medium or worse. */
  flagging: number;
  /** Their titles, for the badge's tooltip. */
  titles: string[];
};

/** The listing row's badge: only for a hit or an incomplete check; `null` leaves the row as it was. */
export function listingEditCheckBadge(
  summary: ListingEditCheckSummary | null | undefined
): { label: string; color: string; title: string | undefined } | null {
  if (!summary) return null;
  if (summary.status === 'pending') {
    return {
      label: 'Impersonation not checked yet: check the listing by hand',
      color: 'orange',
      title: undefined,
    };
  }
  if (summary.status === 'stale') {
    return {
      label: 'Impersonation check out of date (listing changed): check the listing by hand',
      color: 'orange',
      title: undefined,
    };
  }
  if (summary.status === 'skipped') {
    return {
      label: 'Impersonation check skipped (daily budget spent): check the listing by hand',
      color: 'orange',
      title: undefined,
    };
  }
  if (summary.status !== 'complete') {
    return {
      label: 'Impersonation check incomplete: check the listing by hand',
      color: 'orange',
      title: undefined,
    };
  }
  if (summary.flagging === 0) return null;
  return {
    label: 'Impersonation: read the findings before approving',
    color: 'orange',
    title: summary.titles.join('; '),
  };
}
