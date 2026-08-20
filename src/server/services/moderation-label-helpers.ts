/**
 * Label mechanics shared by every XGuard consumer: how to compare a label name, which
 * requested labels the scanner never answered on, which labels a scan counts as
 * triggered, and which terms those labels matched.
 *
 * Deliberately neutral — it holds no label list and no policy. Per-consumer label
 * selection stays with each consumer (`Article` sends one label, `Challenge` two,
 * wildcard a fail set plus a level set, App Blocks and `Model` fifteen); only the
 * evaluation mechanism lives here. Before this existed there were four
 * implementations of "did this label trigger", and hardening one never reached the
 * others.
 *
 * Every field is read as `unknown`: this is untrusted data off a network boundary, and
 * the generated client's types describe the contract rather than what arrives.
 */

export type ScanLabelResultLike = {
  label?: unknown;
  score?: unknown;
  threshold?: unknown;
  triggered?: unknown;
  error?: unknown;
  matchedTerms?: unknown;
};

export type ScanOutputLike = {
  triggeredLabels?: unknown;
  results?: unknown;
};

/**
 * Labels are orchestrator-side configuration, not a code-owned enum — the same label
 * arrives as `young` from one surface and `Young` from another. An exact-match
 * comparison therefore matches nothing for a casing this side does not control, and a
 * policy that matches nothing enforces nothing. Trim before lowercasing: leading
 * whitespace has the same fail-open effect and is invisible in a log.
 */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function readLabel(entry: ScanLabelResultLike): string | null {
  return typeof entry.label === 'string' && entry.label.trim().length > 0
    ? normalizeLabel(entry.label)
    : null;
}

function asResults(output: ScanOutputLike | null | undefined): ScanLabelResultLike[] {
  const raw = output?.results;
  return Array.isArray(raw) ? (raw as ScanLabelResultLike[]) : [];
}

/**
 * Does this entry report that the scanner FAILED on its label? Read by presence, not
 * by value: anything present and non-empty is a failure, including a shape we did not
 * expect. A value we cannot interpret is a non-answer, and a non-answer must never
 * read as clean.
 */
export function labelResultErrored(entry: ScanLabelResultLike): boolean {
  const { error } = entry;
  if (error === null || error === undefined) return false;
  return typeof error === 'string' ? error.trim().length > 0 : true;
}

/**
 * Requested labels absent from `results[]`. Absence means the scanner never answered
 * on that label — distinct from answering below threshold, and invisible in a trigger
 * rate unless it is counted separately.
 */
export function missingRequestedLabels(
  output: ScanOutputLike | null | undefined,
  requestedLabels: readonly string[]
): string[] {
  const evaluated = new Set<string>();
  for (const entry of asResults(output)) {
    if (!entry || typeof entry !== 'object') continue;
    const label = readLabel(entry);
    if (label) evaluated.add(label);
  }
  return requestedLabels.filter((label) => !evaluated.has(normalizeLabel(label)));
}

/**
 * Every label this scan counts as triggered, normalized.
 *
 * `triggeredLabels` and `results[].triggered` are two views of the same fact from a
 * service on the other side of a network boundary; union them so a label present in
 * only one view still counts.
 *
 * `includeScoreThreshold` additionally counts a label whose score reached its own
 * threshold but which carries no `triggered` flag. Consumers differ on this and are
 * allowed to — App Blocks reads `score` for telemetry only, wildcard categories and
 * models fold it into the verdict — so it is an explicit argument rather than a
 * silent per-file reimplementation.
 *
 * An entry whose `error` is populated is never counted: the producer scores an
 * unreadable blob as 0, so an errored label arrives looking exactly like a clean one.
 * A score of 0 is likewise never a trigger, which keeps a `threshold: 0` label from
 * satisfying `0 >= 0`.
 */
export function triggeredLabelKeys(
  output: ScanOutputLike | null | undefined,
  { includeScoreThreshold = false }: { includeScoreThreshold?: boolean } = {}
): Set<string> {
  const keys = new Set<string>();

  const raw = output?.triggeredLabels;
  if (Array.isArray(raw))
    for (const label of raw)
      if (typeof label === 'string' && label.trim().length > 0) keys.add(normalizeLabel(label));

  for (const entry of asResults(output)) {
    if (!entry || typeof entry !== 'object') continue;
    const label = readLabel(entry);
    if (!label || labelResultErrored(entry)) continue;

    if (entry.triggered === true) {
      keys.add(label);
      continue;
    }
    if (!includeScoreThreshold) continue;

    const { score, threshold } = entry;
    if (typeof score !== 'number' || !Number.isFinite(score) || score <= 0) continue;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) continue;
    if (score >= threshold) keys.add(label);
  }

  return keys;
}

/**
 * Union of the text terms matched by the given labels. `results[]` covers every
 * submitted label, not only the ones that fired, so filtering on `triggeredKeys` is
 * load-bearing rather than defensive.
 */
export function collectMatchedTerms(
  output: ScanOutputLike | null | undefined,
  triggeredKeys: ReadonlySet<string>
): string[] {
  const terms = new Set<string>();

  for (const entry of asResults(output)) {
    if (!entry || typeof entry !== 'object') continue;
    const label = readLabel(entry);
    if (!label || !triggeredKeys.has(label)) continue;

    const matched = (entry.matchedTerms as { text?: unknown } | null | undefined)?.text;
    if (!Array.isArray(matched)) continue;
    for (const term of matched)
      if (typeof term === 'string' && term.trim().length > 0) terms.add(term);
  }

  return [...terms];
}
