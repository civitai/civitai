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
    title: optString,
    description: optString,
  })
  .catch({});
export type AgentFinding = z.infer<typeof agentFindingSchema>;

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
