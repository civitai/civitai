/**
 * Experimental presentation — resolving WHAT is experimental.
 *
 * `experimental` is a gate presentation that doesn't gate: the item stays fully
 * usable and only picks up a marker plus a warning (see `gates.ts`). That makes
 * it an annotation on three interchangeable kinds of target, so every surface —
 * picker row, resource card, version button, banner — resolves through
 * `resolveExperimental` instead of re-deriving the union of sources itself.
 *
 * Two sources are folded here so callers can't disagree about them:
 *   - gate rules with `presentation: 'experimental'` (optional message)
 *   - base-model `experimental` flags, for ecosystems (no message)
 */

import { isEcosystemExperimental } from '~/shared/constants/basemodel.constants';
import type { ExperimentalTargets } from './gates';

export type ExperimentalTarget =
  | { kind: 'ecosystem'; key: string }
  | { kind: 'workflow'; key: string }
  | { kind: 'modelVersion'; key: number };

export type ExperimentalMatch = {
  target: ExperimentalTarget;
  /** The rule's extra copy, when it has any. Absent for base-model flags. */
  message?: string;
  /** Unique per target; duplicate candidates collapse on it. */
  key: string;
};

/** Key prefixes keep an ecosystem and a version id from colliding. */
const KIND_PREFIX: Record<ExperimentalTarget['kind'], string> = {
  ecosystem: 'eco',
  workflow: 'wf',
  modelVersion: 'mv',
};

function lookup(
  targets: ExperimentalTargets,
  target: ExperimentalTarget
): { matched: boolean; message?: string } {
  switch (target.kind) {
    case 'ecosystem':
      return {
        matched: targets.ecosystems.has(target.key),
        message: targets.ecosystems.get(target.key),
      };
    case 'workflow':
      return {
        matched: targets.workflows.has(target.key),
        message: targets.workflows.get(target.key),
      };
    case 'modelVersion':
      return {
        matched: targets.modelVersionIds.has(target.key),
        message: targets.modelVersionIds.get(target.key),
      };
  }
}

/**
 * The experimental state of one target, or `undefined` when it isn't
 * experimental. A match with no `message` is normal — the rule didn't set one,
 * or the source was a base-model flag — and the UI supplies default copy.
 */
export function resolveExperimental(
  targets: ExperimentalTargets,
  target: ExperimentalTarget
): ExperimentalMatch | undefined {
  const { matched, message } = lookup(targets, target);
  const matchedStatically = target.kind === 'ecosystem' && isEcosystemExperimental(target.key);
  if (!matched && !matchedStatically) return undefined;
  return { target, message, key: `${KIND_PREFIX[target.kind]}:${target.key}` };
}

/**
 * Resolve several candidates at once, dropping the blanks. Order is preserved so
 * the caller controls which warning reads first.
 */
export function resolveExperimentalMatches(
  targets: ExperimentalTargets,
  candidates: (ExperimentalTarget | undefined)[]
): ExperimentalMatch[] {
  const matches: ExperimentalMatch[] = [];
  for (const candidate of candidates) {
    const match = candidate ? resolveExperimental(targets, candidate) : undefined;
    if (match && !matches.some((m) => m.key === match.key)) matches.push(match);
  }
  return matches;
}
