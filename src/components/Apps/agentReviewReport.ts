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
  const i = SEVERITY_ORDER.indexOf((severity ?? '').toLowerCase() as (typeof SEVERITY_ORDER)[number]);
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
  const b: SeverityBreakdown = { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0, other: 0 };
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
