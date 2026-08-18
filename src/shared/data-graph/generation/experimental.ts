/**
 * Experimental presentation — resolving WHAT is experimental, and under WHICH
 * key its warning is dismissed.
 *
 * `experimental` is the one gate presentation that doesn't gate: the item stays
 * fully usable and only picks up a marker plus a warning (see `gates.ts`). That
 * makes it an annotation on three interchangeable kinds of target, so every
 * surface — picker row, resource card, version button, banner — resolves through
 * `resolveExperimental` instead of re-deriving the union of sources itself.
 *
 * Two sources are folded here so callers can't disagree about them:
 *   - gate rules with `presentation: 'experimental'` (optional message)
 *   - base-model `experimental` flags, for ecosystems (no message)
 *
 * The dismiss key carries a fingerprint of the message. The copy is
 * mod-authored and mutable, so keying on the target alone means an edited
 * warning never reaches anyone who dismissed the old one — the edit changes the
 * fingerprint, the key, and therefore re-notifies.
 */

import { ecosystemByKey, isEcosystemExperimental } from '~/shared/constants/basemodel.constants';
import type { ExperimentalTargets } from './gates';

export type ExperimentalTarget =
  | { kind: 'ecosystem'; key: string }
  | { kind: 'workflow'; key: string }
  | { kind: 'modelVersion'; key: number };

export type ExperimentalMatch = {
  target: ExperimentalTarget;
  /** The rule's extra copy, when it has any. Absent for base-model flags. */
  message?: string;
  /** Storage id for this warning's dismissal, message fingerprint included. */
  dismissId: string;
};

/** Key prefixes keep an ecosystem and a version id from colliding. */
const KIND_PREFIX: Record<ExperimentalTarget['kind'], string> = {
  ecosystem: 'eco',
  workflow: 'wf',
  modelVersion: 'mv',
};

/**
 * djb2 → base36. Only ever compared against itself, so a collision costs one
 * missed re-notify rather than correctness — length is chosen accordingly.
 */
function fingerprint(message: string): string {
  let hash = 5381;
  for (let i = 0; i < message.length; i++) hash = ((hash << 5) + hash + message.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

export function experimentalDismissId(target: ExperimentalTarget, message?: string): string {
  return `${KIND_PREFIX[target.kind]}:${target.key}#${fingerprint(message ?? '')}`;
}

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
  return { target, message, dismissId: experimentalDismissId(target, message) };
}

/**
 * Every dismiss id the current sources can still produce — what a stored set of
 * dismissals is pruned against, so an edited message's orphan is collected and
 * the record stays bounded by what exists.
 */
export function liveExperimentalDismissIds(targets: ExperimentalTargets): string[] {
  const ids: string[] = [];
  for (const [key, message] of targets.ecosystems)
    ids.push(experimentalDismissId({ kind: 'ecosystem', key }, message));
  for (const [key, message] of targets.workflows)
    ids.push(experimentalDismissId({ kind: 'workflow', key }, message));
  for (const [key, message] of targets.modelVersionIds)
    ids.push(experimentalDismissId({ kind: 'modelVersion', key }, message));
  // A base-model flag produces a message-less id. Where a rule targets the same
  // ecosystem its message wins (`lookup` runs first in `resolveExperimental`), so
  // only ecosystems no rule mentions contribute one.
  for (const key of ecosystemByKey.keys())
    if (!targets.ecosystems.has(key) && isEcosystemExperimental(key))
      ids.push(experimentalDismissId({ kind: 'ecosystem', key }));
  return ids;
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
    if (match && !matches.some((m) => m.dismissId === match.dismissId)) matches.push(match);
  }
  return matches;
}
