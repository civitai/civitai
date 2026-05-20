/**
 * Derived labels — pure transform that takes raw XGuard per-label results and
 * applies suppression + derivation rules to produce the audit-write set.
 *
 * Two operations:
 *  - SUPPRESSION: drop redundant rows (e.g. drop `suggestive` when `explicit`
 *    also triggered — Explicit ⊂ Suggestive by design).
 *  - DERIVATION: synthesize new rows from combinations of triggered rows
 *    (e.g. add a `csam` row when `young` co-triggers with any sexual signal).
 *
 * Pure / deterministic / idempotent / mode-scoped.
 *
 * Derivation always reads the PRE-SUPPRESSION result set — keeps future rules
 * that depend on a label that's itself being suppressed from silently breaking.
 *
 * See docs/features/scanner-derived-labels-plan.md for the full plan and
 * rationale.
 */
export type DerivedLabelMode = 'text' | 'prompt';

export type DerivedLabelInput = {
  label: string;
  score: number;
  threshold: number | null;
  triggered: 0 | 1;
  version: string;
  matchedText: string[];
  matchedPositivePrompt: string[];
  matchedNegativePrompt: string[];
};

export type DerivedLabelOutput = DerivedLabelInput & {
  /** True when this row was synthesized by a derivation rule (not emitted by
   * XGuard). Downstream analytics may filter on this to distinguish model
   * signals from derived ones. */
  synthetic: boolean;
  /** Contributing label names for synthetic rows. Empty for non-synthetic. */
  derivedFrom: string[];
};

type SuppressionRule = {
  /** Label name to drop. */
  suppress: string;
  /** Drop only when ALL of these labels also triggered. */
  whenTriggered: string[];
};

type DerivationRule = {
  /** Synthesized label name. */
  emit: string;
  /** All labels in this list must have triggered for the rule to fire. */
  requires: string[];
  /** At least one label in this list must have triggered. (Used for
   * AND-of-ORs derivations like csam = young AND (sexual OR explicit). */
  requiresAnyOf?: string[];
};

type RuleSet = {
  suppressions: SuppressionRule[];
  derivations: DerivationRule[];
};

// Rule sets are mode-scoped. Same labels exist in prompt and text mode for
// the sexual-content axis (young, suggestive, explicit), so the rules end up
// identical today — but keeping them per-mode preserves room for divergence.
const PROMPT_RULES: RuleSet = {
  suppressions: [
    { suppress: 'suggestive', whenTriggered: ['explicit'] }, // hierarchical collapse
  ],
  derivations: [
    {
      emit: 'csam',
      requires: ['young'],
      requiresAnyOf: ['sexual', 'suggestive', 'explicit'],
    },
  ],
};

const TEXT_RULES: RuleSet = {
  suppressions: [{ suppress: 'suggestive', whenTriggered: ['explicit'] }],
  derivations: [
    {
      emit: 'csam',
      requires: ['young'],
      // Text mode keeps `nsfw` as a synonym for the broad sexual-content
      // signal — derivation accepts it alongside suggestive/explicit so
      // legacy text-mode content scanned before the Suggestive/Explicit
      // labels landed still gets a synthetic csam if nsfw co-fires.
      requiresAnyOf: ['nsfw', 'sexual', 'suggestive', 'explicit'],
    },
  ],
};

function rulesFor(mode: DerivedLabelMode): RuleSet {
  return mode === 'text' ? TEXT_RULES : PROMPT_RULES;
}

function unionDedupe(arrays: string[][]): string[] {
  const seen = new Set<string>();
  for (const arr of arrays) for (const v of arr) seen.add(v);
  return [...seen];
}

function minScore(rows: DerivedLabelInput[]): number {
  return rows.reduce((min, r) => Math.min(min, r.score), Infinity);
}

function isTriggered(byLabel: Map<string, DerivedLabelInput>, name: string): boolean {
  const r = byLabel.get(name);
  return !!r && r.triggered === 1;
}

/**
 * Apply derived-label rules to a raw label-result set. Pure / idempotent.
 *
 * Returns a new array. Inputs are wrapped with `{ synthetic: false,
 * derivedFrom: [] }`; suppressed inputs are dropped; synthetic outputs are
 * appended with `{ synthetic: true, derivedFrom: [<contributing label names>] }`.
 *
 * IMPORTANT: derivation rules read the PRE-suppression triggered set. So a
 * derivation can fire on `suggestive` even when `suggestive` is being
 * suppressed by another rule.
 */
export function applyDerivedLabels(
  rows: DerivedLabelInput[],
  mode: DerivedLabelMode
): DerivedLabelOutput[] {
  const rules = rulesFor(mode);
  const byLabel = new Map(rows.map((r) => [r.label, r]));

  // Names owned by derivation rules. Any input row using one of these names
  // is stripped — derivation rules are authoritative about whether their
  // synthetic label exists. If the rule fires, we emit one. If the rule
  // doesn't fire, the label doesn't exist in the output (regardless of
  // what came in). This keeps the function correct under rule changes:
  // a label that used to be derived but no longer matches its rule won't
  // linger because a previous pass added it.
  const syntheticLabelNames = new Set(rules.derivations.map((r) => r.emit));

  // Determine which inputs to suppress.
  const suppressed = new Set<string>();
  for (const rule of rules.suppressions) {
    const target = byLabel.get(rule.suppress);
    if (!target || target.triggered !== 1) continue;
    const allDominatorsTriggered = rule.whenTriggered.every((name) => isTriggered(byLabel, name));
    if (allDominatorsTriggered) suppressed.add(rule.suppress);
  }

  // Pass-through inputs with metadata. Excludes:
  //  - rows suppressed by a suppression rule
  //  - rows whose label name is owned by a derivation rule (stripped so
  //    derivation can decide whether to re-emit)
  const out: DerivedLabelOutput[] = [];
  for (const row of rows) {
    if (suppressed.has(row.label)) continue;
    if (syntheticLabelNames.has(row.label)) continue;
    out.push({ ...row, synthetic: false, derivedFrom: [] });
  }

  // Apply derivation rules. Reads the PRE-suppression `byLabel` map so a
  // synthesis depending on a soon-to-be-suppressed input still fires.
  for (const rule of rules.derivations) {
    const allRequired = rule.requires.every((name) => isTriggered(byLabel, name));
    if (!allRequired) continue;

    let anyOfMatch: string | null = null;
    if (rule.requiresAnyOf && rule.requiresAnyOf.length > 0) {
      anyOfMatch = rule.requiresAnyOf.find((name) => isTriggered(byLabel, name)) ?? null;
      if (!anyOfMatch) continue;
    }

    const contributingNames = [...rule.requires, ...(anyOfMatch ? [anyOfMatch] : [])];
    const contributingRows = contributingNames
      .map((n) => byLabel.get(n))
      .filter((r): r is DerivedLabelInput => !!r);

    // Synthetic row: triggered=1 by construction, score = weakest input,
    // threshold = NULL (no model threshold applies), policy version is the
    // SHA of the rule itself (computed by the caller / deferred for now —
    // we leave version blank and let the caller stamp it if needed).
    const synthetic: DerivedLabelOutput = {
      label: rule.emit,
      score: minScore(contributingRows),
      threshold: null,
      triggered: 1,
      // Empty version — derived rows don't have a model policyHash. A future
      // change can stamp a hash of the rule set here for analytics bucketing.
      version: '',
      matchedText: unionDedupe(contributingRows.map((r) => r.matchedText)),
      matchedPositivePrompt: unionDedupe(contributingRows.map((r) => r.matchedPositivePrompt)),
      matchedNegativePrompt: unionDedupe(contributingRows.map((r) => r.matchedNegativePrompt)),
      synthetic: true,
      derivedFrom: contributingNames,
    };
    out.push(synthetic);
  }

  return out;
}

/**
 * Compute the diff between a raw label set and the derived set produced by
 * `applyDerivedLabels`. Used by the dry-run telemetry path during Phase 1
 * rollout to log how the derivation would have changed the audit-write set,
 * without actually changing it.
 */
export function diffDerivedLabels(
  raw: DerivedLabelInput[],
  derived: DerivedLabelOutput[]
): {
  suppressed: string[];
  synthesized: Array<{ label: string; derivedFrom: string[] }>;
} {
  const rawLabels = new Set(raw.map((r) => r.label));
  const derivedLabels = new Set(derived.map((d) => d.label));

  const suppressed = [...rawLabels].filter((l) => !derivedLabels.has(l));
  const synthesized = derived
    .filter((d) => d.synthetic)
    .map((d) => ({ label: d.label, derivedFrom: d.derivedFrom }));

  return { suppressed, synthesized };
}
