import { ecosystemById, getEcosystemGroupByKey } from '~/shared/constants/basemodel.constants';
import {
  getOutputTypeForWorkflow,
  workflowConfigByKey,
  workflowConfigs,
} from '~/shared/data-graph/generation/config/workflows';

/**
 * The per-output reset predicate for `store.prune` — the form-graph
 * counterpart of v1's `clearStorageForOutput` + `graph.reset`: clears only
 * the buckets belonging to ONE output type, so resetting the image form
 * leaves video/audio/3D settings intact.
 *
 * Addresses are `key` (bare — the globally-scoped fields: workflow, the text
 * block, seed) or `key@scope` with scope parts joined by `/`. Buckets:
 *   - `<output>` — the per-output ecosystem selection (`ecosystem@video`)
 *   - a workflow key — `workflowScoped` fields (`images@img2vid:ref2vid`)
 *   - a family bucket — an ecosystem key or group id, optionally with a
 *     per-model segment (`steps@LTXV23/12345`)
 *
 * Bare keys always clear (v1's reset clears them), except the caller's
 * `exclude` list (output preferences like outputFormat/priority). A family
 * bucket serving several outputs (Grok spans image and video) clears on any
 * of its outputs' resets — the storage is genuinely shared there.
 */

const OUTPUT_TYPES = new Set(['image', 'video', 'audio', 'model3d']);

/** Family buckets (familyScope values) for every ecosystem serving an output. */
function familyBucketsForOutput(output: string): Set<string> {
  const buckets = new Set<string>();
  for (const config of Object.values(workflowConfigs)) {
    if (config.category !== output) continue;
    for (const id of config.ecosystemIds ?? []) {
      const key = ecosystemById.get(id)?.key;
      if (!key) continue;
      buckets.add(getEcosystemGroupByKey(key)?.id ?? key);
    }
  }
  return buckets;
}

export function outputResetPredicate(
  output: 'image' | 'video' | 'audio' | 'model3d',
  opts: { exclude?: readonly string[] } = {}
): (address: string) => boolean {
  const exclude = new Set(opts.exclude ?? []);
  const familyBuckets = familyBucketsForOutput(output);

  return (address: string) => {
    const at = address.indexOf('@');
    const key = at === -1 ? address : address.slice(0, at);
    if (exclude.has(key)) return false;
    if (at === -1) return true;

    const firstSegment = address.slice(at + 1).split('/')[0]!;
    if (OUTPUT_TYPES.has(firstSegment)) return firstSegment === output;
    if (workflowConfigByKey.has(firstSegment))
      return getOutputTypeForWorkflow(firstSegment) === output;
    return familyBuckets.has(firstSegment);
  };
}
