import { z } from 'zod';

/**
 * App Blocks — AGENTIC MOD CODE-REVIEW (P2) report view-model + parsing.
 *
 * THE SANITIZATION BOUNDARY. The `codeReview` / `securityAudit` / `scopeVerdicts`
 * / `tokenUsage` columns are adversarial LLM output produced from an UNTRUSTED
 * bundle: the analysed app author controls the code the agent reads, so the model
 * text can carry markup, prompt-injection, or malformed shapes. Everything the
 * UI renders flows through the tolerant Zod schemas below FIRST.
 *
 * Tolerance contract (why every field is `.catch()`-wrapped, never a bare parse):
 *  - unknown/extra keys are STRIPPED (default Zod object behaviour),
 *  - a missing field defaults to its empty value ([] / undefined),
 *  - a WRONG-TYPED field (e.g. `severity` is an object, `findings` is a string)
 *    is treated as absent instead of THROWING — a single malformed field must
 *    never blank the whole report or crash the modal.
 * The schemas do NOT sanitize the string CONTENT (that is impossible to do
 * safely by transform) — they guarantee the shape. The panel renders every
 * string as inert TEXT (never `dangerouslySetInnerHTML` / raw HTML), which is
 * the actual stored-XSS-at-render guard.
 */

/** A string field that falls back to `undefined` on any non-string input. */
const optString = z.string().optional().catch(undefined);
/** A `file:line`-style line ref — number or string; anything else → undefined. */
const optLine = z.union([z.number(), z.string()]).optional().catch(undefined);
const optBool = z.boolean().optional().catch(undefined);
/** A string array that falls back to `[]` on any non-array / wrong-element input. */
const stringArray = z
  .array(z.string())
  .catch([])
  // filter defends against a mixed array that partially coerces
  .transform((a) => a.filter((s): s is string => typeof s === 'string'));

// --- Code review -----------------------------------------------------------

export const agentFindingSchema = z
  .object({
    file: optString,
    line: optLine,
    severity: optString,
    category: optString,
    title: optString,
    // `detail` is the runner's primary body field; `description` is kept for
    // back-compat with earlier report rows. The UI renders `detail ?? description`.
    detail: optString,
    description: optString,
    evidence: stringArray,
    suggestion: optString,
    // Code-review-only: the diff status of the finding's location ('added' | …).
    diffStatus: optString,
    // Security-audit-only: the agent's confidence in the finding ('high' | …).
    confidence: optString,
  })
  // Fallback keeps `evidence` a defined array so callers never guard `.map`.
  .catch({ evidence: [] });
export type AgentFinding = z.infer<typeof agentFindingSchema>;

/** The body text of a finding — the richer `detail` wins over legacy `description`. */
export function findingBody(f: AgentFinding): string | undefined {
  return f.detail ?? f.description;
}

export const priorFindingSchema = z
  .object({
    title: optString,
    status: optString, // 'resolved' | 'still-present' | 'regressed' (rendered tolerantly)
  })
  .catch({});
export type PriorFinding = z.infer<typeof priorFindingSchema>;

export const codeReviewSchema = z
  .object({
    findings: z.array(agentFindingSchema).catch([]),
    priorFindingsReconciled: z.array(priorFindingSchema).catch([]),
    notes: optString,
  })
  .catch({ findings: [], priorFindingsReconciled: [], notes: undefined });
export type CodeReviewView = z.infer<typeof codeReviewSchema>;

// --- Security audit --------------------------------------------------------

export const promptInjectionAttemptSchema = z
  .object({
    file: optString,
    excerpt: optString,
  })
  .catch({});
export type PromptInjectionAttempt = z.infer<typeof promptInjectionAttemptSchema>;

export const securityAuditSchema = z
  .object({
    findings: z.array(agentFindingSchema).catch([]),
    manifestUnexpectedKeys: stringArray,
    iframeSandboxGrants: stringArray,
    promptInjectionAttempts: z.array(promptInjectionAttemptSchema).catch([]),
    notes: optString,
  })
  .catch({
    findings: [],
    manifestUnexpectedKeys: [],
    iframeSandboxGrants: [],
    promptInjectionAttempts: [],
    notes: undefined,
  });
export type SecurityAuditView = z.infer<typeof securityAuditSchema>;

// --- Scope verdicts --------------------------------------------------------

export const scopeVerdictSchema = z
  .object({
    declared: optString,
    kind: optString,
    used: optString, // 'yes' | 'no' | 'unclear'
    justificationAccurate: optString, // 'yes' | 'no' | 'weak'
    sensitive: optBool,
    evidence: stringArray,
    notes: optString,
  })
  .catch({ evidence: [] });
export type ScopeVerdict = z.infer<typeof scopeVerdictSchema>;

export const scopeVerdictsSchema = z
  .object({
    scopes: z.array(scopeVerdictSchema).catch([]),
    overBroad: stringArray,
    underDeclared: stringArray,
  })
  .catch({ scopes: [], overBroad: [], underDeclared: [] });
export type ScopeVerdictsView = z.infer<typeof scopeVerdictsSchema>;

// --- Token usage -----------------------------------------------------------

export const tokenUsageSchema = z
  .object({
    promptTokens: z.number().optional().catch(undefined),
    completionTokens: z.number().optional().catch(undefined),
  })
  .catch({});
export type TokenUsageView = z.infer<typeof tokenUsageSchema>;

/** The fully-parsed, safe-to-render view-model of a report's structured fields. */
export type AgentReportView = {
  codeReview: CodeReviewView;
  securityAudit: SecurityAuditView;
  scopeVerdicts: ScopeVerdictsView;
  tokenUsage: TokenUsageView;
};

/** Parse the adversarial Json columns of a report row into safe view-models. */
export function parseAgentReport(report: {
  codeReview?: unknown;
  securityAudit?: unknown;
  scopeVerdicts?: unknown;
  tokenUsage?: unknown;
}): AgentReportView {
  return {
    codeReview: codeReviewSchema.parse(report.codeReview),
    securityAudit: securityAuditSchema.parse(report.securityAudit),
    scopeVerdicts: scopeVerdictsSchema.parse(report.scopeVerdicts),
    tokenUsage: tokenUsageSchema.parse(report.tokenUsage),
  };
}

/**
 * Render a `costUsd` value (Prisma Decimal over the wire, or a number/string in
 * tests) as a `$x.xxxx` label — null/NaN → null (caller omits the line).
 */
export function formatCostUsd(costUsd: unknown): string | null {
  if (costUsd == null) return null;
  const n = typeof costUsd === 'number' ? costUsd : Number(String(costUsd));
  if (!Number.isFinite(n)) return null;
  return `$${n.toFixed(4)}`;
}

/** A `file:line` display string from a finding — tolerant of missing parts. */
export function fileLineLabel(file?: string, line?: number | string): string | null {
  if (!file) return null;
  return line == null || line === '' ? file : `${file}:${line}`;
}

// --- Severity ordering + roll-up (pure, unit-testable) ---------------------

/** Severity buckets in descending-risk order. Unknown severities sort LAST. */
export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'moderate', 'low', 'info'] as const;

/**
 * Rank a severity for sorting — lower = higher risk (sorts first). Unknown /
 * missing severities get a rank past the known set so they land at the bottom,
 * never above a real `low`/`info` finding.
 */
export function severityRank(severity?: string): number {
  const i = SEVERITY_ORDER.indexOf(
    (severity ?? '').toLowerCase() as (typeof SEVERITY_ORDER)[number]
  );
  return i === -1 ? SEVERITY_ORDER.length : i;
}

/**
 * A severity-sorted COPY of the findings (critical → info → unknown), stable
 * within a bucket (original order preserved) so equal-severity findings keep the
 * agent's ordering. Never mutates the input.
 */
export function sortFindingsBySeverity(findings: AgentFinding[]): AgentFinding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => severityRank(a.f.severity) - severityRank(b.f.severity) || a.i - b.i)
    .map((x) => x.f);
}

export type SeverityBreakdown = {
  total: number;
  critical: number;
  high: number;
  /** `medium` + `moderate` collapsed into one bucket. */
  medium: number;
  low: number;
  info: number;
  /** Anything with an unknown / missing severity. */
  other: number;
};

/** Count findings per severity bucket for the counts-first roll-up. */
export function severityBreakdown(findings: AgentFinding[]): SeverityBreakdown {
  const b: SeverityBreakdown = {
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    other: 0,
  };
  for (const f of findings) {
    b.total += 1;
    switch ((f.severity ?? '').toLowerCase()) {
      case 'critical':
        b.critical += 1;
        break;
      case 'high':
        b.high += 1;
        break;
      case 'medium':
      case 'moderate':
        b.medium += 1;
        break;
      case 'low':
        b.low += 1;
        break;
      case 'info':
        b.info += 1;
        break;
      default:
        b.other += 1;
    }
  }
  return b;
}

// --- Deep-link to a finding (pure, unit-testable) --------------------------

/**
 * The report renderer's tab identifiers (in display order: Scopes → Security →
 * Code review). The former `summary` tab was dropped — the agent prose overview
 * is no longer surfaced in this renderer.
 */
export type ReportTabValue = 'scopes' | 'security' | 'code';

const REPORT_TAB_VALUES: readonly ReportTabValue[] = ['scopes', 'security', 'code'];

/** The two tabs that carry per-finding anchors (scopes does not). */
export type FindingTab = 'code' | 'security';

/**
 * The DOM id / deep-link anchor for a single finding. `index` is the finding's
 * position in the SEVERITY-SORTED render list (the order the moderator sees), so
 * a shared `#finding-<tab>-<index>` link lands on the same visible card.
 */
export function findingAnchorId(tab: FindingTab, index: number): string {
  return `finding-${tab}-${index}`;
}

/** `finding-<code|security>-<index>` where index is a non-negative integer. */
const FINDING_ANCHOR_RE = /^finding-(code|security)-(\d+)$/;

/**
 * Parse a report URL hash into a tab + optional finding anchor. Total and
 * defensive — never throws on junk. Recognizes:
 *   - `#finding-security-2` → { tab: 'security', anchorId: 'finding-security-2' }
 *   - a bare `#code` / `#summary` / `#security` / `#scopes` → { tab }
 *   - empty / unknown / malformed → {}
 * Tolerates a leading `#` or none. A tab value outside the union is ignored.
 */
export function parseReportHash(hash: string): { tab?: ReportTabValue; anchorId?: string } {
  if (typeof hash !== 'string') return {};
  const raw = (hash.startsWith('#') ? hash.slice(1) : hash).trim();
  if (!raw) return {};
  const findingMatch = FINDING_ANCHOR_RE.exec(raw);
  if (findingMatch) {
    // Group 1 is 'code' | 'security', both members of the tab union.
    return { tab: findingMatch[1] as FindingTab, anchorId: raw };
  }
  if ((REPORT_TAB_VALUES as readonly string[]).includes(raw)) {
    return { tab: raw as ReportTabValue };
  }
  return {};
}

/**
 * Detect a FAILED analysis section. The runner persists each of
 * `codeReview` / `securityAudit` / `scopeVerdicts` verbatim; if a sub-analysis
 * failed it stores an `{ error: … }` object (or a bare string) in that slot
 * instead of the structured shape. The tolerant `parseAgentReport` would quietly
 * flatten that to an EMPTY section (indistinguishable from "nothing found"), so
 * this structural check runs on the RAW slot first to surface an explicit
 * "analysis failed" state. Returns the trimmed error message, or `null` when the
 * slot is absent/empty/well-formed.
 */
export function sectionAnalysisError(raw: unknown): string | null {
  if (raw == null) return null;
  // A bare string in a structured slot is a runner failure/log dump, not data.
  if (typeof raw === 'string') {
    const s = raw.trim();
    return s ? s.slice(0, 500) : null;
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if ('error' in o && o.error != null) {
      const e = o.error;
      const msg = typeof e === 'string' ? e : JSON.stringify(e);
      return msg.slice(0, 500);
    }
  }
  return null;
}

// --- Per-section status (pure, unit-testable) ------------------------------

/**
 * The three sub-analyses a report is made of, in DISPLAY ORDER.
 *
 * 🔴 ONE LEDGER, because the whole point of what follows is that a report is THREE
 * independently-succeeding things rather than one. Every per-section derivation below maps
 * over this list, so adding a fourth analysis cannot leave a status tally, a retry control
 * or an error message behind.
 */
export const AGENT_REPORT_SECTIONS = ['scopeVerdicts', 'securityAudit', 'codeReview'] as const;
export type AgentReportSection = (typeof AGENT_REPORT_SECTIONS)[number];

export function isAgentReportSection(value: unknown): value is AgentReportSection {
  return typeof value === 'string' && (AGENT_REPORT_SECTIONS as readonly string[]).includes(value);
}

/** The label a moderator sees for a section. */
export const AGENT_REPORT_SECTION_LABELS: Record<AgentReportSection, string> = {
  scopeVerdicts: 'Scopes',
  securityAudit: 'Security audit',
  codeReview: 'Code review',
};

/**
 * What ONE sub-analysis did.
 *   · `complete` — it produced a structured result (even an empty one: "no findings" IS a
 *     finding about the bundle).
 *   · `failed`   — the slot holds an `{ error: … }` object or a bare string log dump.
 *   · `missing`  — the slot is absent/null. A run that was torn down, or never got this far.
 */
export type AgentSectionStatus = 'complete' | 'failed' | 'missing';

/** Raw report slots, as stored. */
export type AgentReportSlots = {
  codeReview?: unknown;
  securityAudit?: unknown;
  scopeVerdicts?: unknown;
};

/**
 * Per-section status for a report row.
 *
 * 🔴 THIS IS THE FIX FOR THE "ALL-OR-NOTHING FAILED REPORT". The runner marks the WHOLE
 * report `failed` when ANY ONE sub-analysis fails, and the UI took that at its word: a mod
 * saw a red "the agentic review failed" banner over a security audit and a scope trace that
 * were perfectly good, with no way to read them and only a whole-report re-run — which
 * re-bills all three analyses — as an affordance. Measured on live rows: 4 of 11 runs were
 * `failed`, and the most recent of those had TWO complete sections and one broken one.
 *
 * 🔴 IT READS THE RAW SLOTS, NOT THE PARSED VIEW. `parseAgentReport` is deliberately
 * tolerant: it flattens an `{ error: … }` object to an EMPTY section, which is
 * indistinguishable from "this analysis ran and found nothing". The structural check has to
 * run first, which is exactly what {@link sectionAnalysisError} exists for.
 */
export function agentReportSectionStatuses(
  report: AgentReportSlots
): Record<AgentReportSection, AgentSectionStatus> {
  const out = {} as Record<AgentReportSection, AgentSectionStatus>;
  for (const section of AGENT_REPORT_SECTIONS) {
    const raw = report[section];
    if (sectionAnalysisError(raw) != null) out[section] = 'failed';
    else if (raw == null) out[section] = 'missing';
    else out[section] = 'complete';
  }
  return out;
}

/** The sections that FAILED, in display order. */
export function failedAgentReportSections(report: AgentReportSlots): AgentReportSection[] {
  const statuses = agentReportSectionStatuses(report);
  return AGENT_REPORT_SECTIONS.filter((s) => statuses[s] === 'failed');
}

/**
 * Does this report carry anything a moderator can actually read?
 *
 * 🔴 THE GATE ON SHOWING A `failed` REPORT'S BODY AT ALL. `true` ⇒ render the sections (the
 * complete ones show their content, the broken ones their own failure state) instead of one
 * banner over everything. `false` ⇒ nothing survived, so the whole-report failure IS the
 * whole story and the banner is the honest surface.
 */
export function hasUsableAgentReportSection(report: AgentReportSlots): boolean {
  const statuses = agentReportSectionStatuses(report);
  return AGENT_REPORT_SECTIONS.some((s) => statuses[s] === 'complete');
}

/**
 * Known machine-readable section error CODES → what to tell a moderator.
 *
 * 🔴 KEYED ON THE EXACT STORED STRING, and `truncated-response` is a NEW code the agent
 * script is gaining in a companion infra change. Until that ships this entry simply never
 * matches — which is the degradation we want: an unknown code falls through to being shown
 * VERBATIM (see {@link sectionErrorMessage}), so a code this table has never heard of is
 * still reported rather than swallowed.
 *
 * The two are worth separating because they call for different actions. A non-JSON response
 * means the model answered in prose where a schema was required — a re-run usually fixes it.
 * A truncated response means the answer was cut off mid-structure, which is a size problem:
 * re-running the same bundle will usually truncate again.
 */
export const AGENT_SECTION_ERROR_MESSAGES: Record<string, string> = {
  'non-json-response':
    'The analysis replied in prose instead of the structured format, so nothing could be ' +
    'read from it. Re-running this one analysis usually clears it.',
  'truncated-response':
    'The analysis reply was cut off before it finished, so the structured result is ' +
    'incomplete. This is usually a size problem rather than a transient one — re-running ' +
    'the same bundle will often truncate again.',
};

/**
 * The moderator-facing message for a failed section, or `null` when it did not fail.
 *
 * 🔴 AN UNRECOGNISED ERROR IS SHOWN VERBATIM, NEVER REPLACED BY A GENERIC LINE. The stored
 * value is the only evidence a mod has about why an analysis produced nothing, and the codes
 * are written by a runner in a different repo that can add one at any time. A table lookup
 * that fell back to "the analysis failed" would turn every future code into no information
 * at all.
 *
 * ⚠️ THE VALUE IS ADVERSARIAL, like everything else in a report: it is produced while
 * processing an untrusted, prompt-injectable bundle. It is returned as a plain string and
 * rendered as inert React text (never `dangerouslySetInnerHTML`) — see `ReportTabs`.
 */
export function sectionErrorMessage(raw: unknown): string | null {
  const error = sectionAnalysisError(raw);
  if (error == null) return null;
  return AGENT_SECTION_ERROR_MESSAGES[error] ?? error;
}
