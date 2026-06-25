/**
 * Pure row-builder for the `scanner_regex_shadow_results` ClickHouse table.
 *
 * Extracted from scanner-audit.service.ts so the NULL-safety invariant below
 * is unit-testable without pulling in the clickhouse client / prisma / env
 * (importing the service module boots the whole server DB chain).
 */
import type { LabelMatchResult } from '~/server/services/scanner-label-regex';
import { REGEX_VERSION } from '~/server/services/scanner-label-regex';

/** Minimal shape of an XGuard label needed to fill the shadow row. Matches the
 *  relevant subset of scanner-audit.service's LabelRowSeed. */
export type RegexShadowXGuardLabel = {
  label: string;
  triggered: 0 | 1;
  score: number;
  threshold: number | null;
  version: string;
};

/** One row destined for `scanner_regex_shadow_results`. The `xguard*` columns
 *  are Nullable in the table EXCEPT for what the materialized columns derive
 *  from `xguardTriggered` — hence `xguardTriggered` is a non-nullable 0|1 here
 *  (see buildRegexShadowRows for the rationale). */
export type RegexShadowRow = {
  workflowId: string;
  contentHash: string;
  scanner: 'xguard_prompt' | 'xguard_text';
  label: string;
  regexMatched: 0 | 1;
  regexReason: string;
  regexMatchedTerms: string[];
  regexVersion: string;
  xguardTriggered: 0 | 1;
  xguardScore: number | null;
  xguardThreshold: number | null;
  xguardPolicyHash: string | null;
  scannedAt: Date;
};

/**
 * Build the `scanner_regex_shadow_results` rows from regex-match output joined
 * to the XGuard labels. Pure (no I/O).
 *
 * INVARIANT: `xguardTriggered` is NEVER NULL. The table has a non-nullable
 * MATERIALIZED column `xguardOnlyFire = (regexMatched = 0) AND
 * (xguardTriggered = 1)` that does NOT coalesce (unlike `agree` /
 * `regexOnlyFire`, which wrap it in `coalesce(xguardTriggered, 0)`). A NULL
 * `xguardTriggered` makes that AND evaluate to NULL → ClickHouse fails the
 * whole insert with code 349 (CANNOT_INSERT_NULL_IN_ORDINARY_COLUMN). When no
 * XGuard label matched the regex label, "XGuard did not trigger" → 0.
 * (Schema rec: also coalesce in the `xguardOnlyFire` DDL — tracked separately,
 * not changed in this PR.)
 */
export function buildRegexShadowRows(args: {
  workflowId: string;
  contentHash: string;
  scanner: 'xguard_prompt' | 'xguard_text';
  regexResults: LabelMatchResult[];
  xguardLabels: RegexShadowXGuardLabel[];
  scannedAt: Date;
}): RegexShadowRow[] {
  return args.regexResults.map((r) => {
    const xg = args.xguardLabels.find((l) => l.label === r.label);
    return {
      workflowId: args.workflowId,
      contentHash: args.contentHash,
      scanner: args.scanner,
      label: r.label,
      regexMatched: r.matched ? 1 : 0,
      regexReason: r.reason,
      regexMatchedTerms: r.matchedTerms,
      regexVersion: REGEX_VERSION,
      xguardTriggered: xg ? xg.triggered : 0,
      xguardScore: xg?.score ?? null,
      xguardThreshold: xg?.threshold ?? null,
      xguardPolicyHash: xg?.version ?? null,
      scannedAt: args.scannedAt,
    };
  });
}
