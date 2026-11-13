import { z } from 'zod';
import {
  AGENT_REVIEW_SECTION_LABELS,
  AGENT_REVIEW_SECTIONS,
  isAgentSectionFailureMarker,
  type AgentReviewSection,
} from '~/shared/constants/agent-review-section.constants';

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
 * Detect a FAILED analysis section — the trimmed error message, or `null` when the slot is
 * absent / well-formed.
 *
 * 🔴 A THIN RE-EXPORT OF `agentSectionFailureMessage`, kept under its original name because
 * it is the view-model's published surface and several callers import it from here. The
 * IMPLEMENTATION moved to `~/shared/constants/agent-review-section.constants` so the
 * provisioning service — which must recognise exactly the same failure encodings before it
 * carries a section forward — reads the same predicate instead of a second copy that drifts
 * the first time the runner adds an encoding.
 */
export { agentSectionFailureMessage as sectionAnalysisError } from '~/shared/constants/agent-review-section.constants';

// --- Per-section status (pure, unit-testable) ------------------------------

/**
 * 🔴 THE LEDGER, THE FAILURE PREDICATE AND THE ERROR TABLE NOW LIVE IN
 * `~/shared/constants/agent-review-section.constants` — one source for the client renderer,
 * the tRPC input schema and the provisioning service, none of which may import each other.
 * Re-exported here so every existing consumer of this module keeps its import, and so the
 * view-model stays the one place a RENDERER has to look.
 */
export {
  AGENT_REVIEW_SECTIONS as AGENT_REPORT_SECTIONS,
  AGENT_REVIEW_SECTION_LABELS as AGENT_REPORT_SECTION_LABELS,
  AGENT_SECTION_ERROR_MESSAGES,
  agentSectionErrorMessage as sectionErrorMessage,
  isAgentReviewSection as isAgentReportSection,
  type AgentReviewSection as AgentReportSection,
} from '~/shared/constants/agent-review-section.constants';

/**
 * What ONE sub-analysis did.
 *   · `complete` — it produced a structured result (even an empty one: "no findings" IS a
 *     finding about the bundle).
 *   · `failed`   — the slot holds an `{ error: … }` object or a bare string log dump.
 *   · `missing`  — the slot is absent/null. The analysis NEVER RAN: a run torn down
 *     mid-flight, a provisioning failure, or a targeted re-run whose siblings were not
 *     carried forward. 🔴 THIS IS NOT "found nothing" AND MUST NOT RENDER AS IT — see
 *     `ReportTabs`' `SectionDidNotRun`.
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
 * `failed`, and the most recent of them had `code_review = {"error":"non-json-response"}`
 * beside two sections with real content.
 *
 * 🔴 IT READS THE RAW SLOTS, NOT THE PARSED VIEW. `parseAgentReport` is deliberately
 * tolerant: it flattens an `{ error: … }` object to an EMPTY section, which is
 * indistinguishable from "this analysis ran and found nothing". The structural check has to
 * run first, which is what `agentSectionFailureMessage` exists for.
 */
export function agentReportSectionStatuses(
  report: AgentReportSlots
): Record<AgentReviewSection, AgentSectionStatus> {
  const out = {} as Record<AgentReviewSection, AgentSectionStatus>;
  for (const section of AGENT_REVIEW_SECTIONS) {
    const raw = report[section];
    if (isAgentSectionFailureMarker(raw)) out[section] = 'failed';
    else if (raw == null) out[section] = 'missing';
    else out[section] = 'complete';
  }
  return out;
}

/** The sections that FAILED, in display order. */
export function failedAgentReportSections(report: AgentReportSlots): AgentReviewSection[] {
  const statuses = agentReportSectionStatuses(report);
  return AGENT_REVIEW_SECTIONS.filter((s) => statuses[s] === 'failed');
}

/**
 * The sections that NEVER RAN, in display order.
 *
 * 🔴 SEPARATE FROM `failedAgentReportSections`, AND BOTH ARE NEEDED. A degraded header that
 * counted only failures printed the literal `0 analyses failed ()` for the commonest shape
 * this change itself creates: a targeted re-run seeds the untouched sections forward and
 * leaves the retried one null, so a provisioning failure on that new row yields a `failed`
 * report with one complete section and two MISSING ones — no failures at all.
 */
export function missingAgentReportSections(report: AgentReportSlots): AgentReviewSection[] {
  const statuses = agentReportSectionStatuses(report);
  return AGENT_REVIEW_SECTIONS.filter((s) => statuses[s] === 'missing');
}

/**
 * Does this report carry anything a moderator can actually read?
 *
 * 🔴 THE GATE ON SHOWING A `failed` REPORT'S BODY AT ALL. `true` ⇒ render the sections (the
 * complete ones show their content, the broken ones their own failure state, the absent ones
 * a "did not run" state) instead of one banner over everything. `false` ⇒ nothing survived,
 * so the whole-report failure IS the whole story and the banner is the honest surface.
 */
export function hasUsableAgentReportSection(report: AgentReportSlots): boolean {
  const statuses = agentReportSectionStatuses(report);
  return AGENT_REVIEW_SECTIONS.some((s) => statuses[s] === 'complete');
}

/**
 * The one-line account above a PARTIALLY usable report.
 *
 * 🔴 IT MUST NEVER PRINT `0 analyses failed ()`, and the naive version did. `partiallyUsable`
 * only requires ONE complete section, so it is satisfied by a `failed` row whose other slots
 * are MISSING rather than failed — the shape a targeted re-run creates, since the retried
 * section is left null for the runner to fill. Counting only failures then produced a header
 * claiming nothing went wrong above a report with two analyses absent.
 *
 * Three distinct things to say, because they call for different moderator actions:
 *   · failed  — it ran and broke; the reason is in its tab, and a re-run usually helps.
 *   · missing — it never ran; there is no verdict, clean or otherwise.
 *   · neither — the row is recorded `failed` but every analysis is present. Say THAT rather
 *     than inventing a count; it means the failure was outside the analyses themselves.
 *
 * 🔴 IT LIVES IN THE PURE VIEW-MODEL, NOT IN THE PANEL. It is a string derivation, and the
 * node-env `unit` project is where its wording is pinned — importing it from the React
 * component would drag Mantine and the tRPC client into that tier for one function.
 */
export function degradedReportSummary(
  failedSections: readonly AgentReviewSection[],
  missingSections: readonly AgentReviewSection[]
): string {
  const name = (s: AgentReviewSection) => AGENT_REVIEW_SECTION_LABELS[s];
  const parts: string[] = [];
  if (failedSections.length > 0) {
    parts.push(
      `${
        failedSections.length === 1 ? 'One analysis' : `${failedSections.length} analyses`
      } failed (${failedSections.map(name).join(', ')})`
    );
  }
  if (missingSections.length > 0) {
    parts.push(
      `${
        missingSections.length === 1 ? 'one analysis' : `${missingSections.length} analyses`
      } never ran (${missingSections.map(name).join(', ')})`
    );
  }
  if (parts.length === 0) {
    return (
      'This run is recorded as failed, but every analysis produced a result. The report ' +
      'below is complete — the failure was outside the analyses themselves.'
    );
  }
  return `${parts.join(', and ')}. What did complete is shown below.`;
}
