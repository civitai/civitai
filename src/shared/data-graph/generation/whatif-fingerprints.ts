/**
 * WhatIf Fingerprints
 *
 * Per-node value projections used to decide whether a graph change should
 * trigger a `whatIf` (cost-estimation) refetch.
 *
 * Each entry is keyed by the node key. The function projects the node's
 * value to the slice that actually affects cost. Return `undefined` to
 * drop the node from change detection entirely.
 *
 * To opt a new node into custom whatIf change detection, add an entry here
 * keyed by its node key. Nodes without an entry are compared by their raw
 * value (the default).
 *
 * This is co-located with the generation graph deliberately — the data-graph
 * library has no knowledge of whatIf or cost estimation.
 */

import type { ControlNetsNodeValue } from './common';
import type { ResourceData } from './common';

export type WhatIfFingerprint = (value: unknown) => unknown;

export const whatIfFingerprints: Record<string, WhatIfFingerprint> = {
  // Strength changes don't affect cost; only the set of resource ids does.
  resources: (value) => {
    const resources = value as ResourceData[] | undefined;
    return resources?.map((r) => ({ id: r.id, type: r.model.type })) ?? [];
  },

  // Weight / startStep / endStep changes don't affect cost — only the
  // preprocessor + reference image do (and counts toward # of controlnets).
  controlNets: (value) => {
    const entries = value as ControlNetsNodeValue | undefined;
    return (
      entries?.map((entry) => ({
        preprocessor: entry.preprocessor,
        imageUrl: entry.image?.url,
      })) ?? []
    );
  },

  // Content fields don't affect cost (site identity determines buzz type;
  // prompt moderation happens at submission time). Returning `undefined`
  // drops the key from the whatIf comparison entirely.
  prompt: () => undefined,
  negativePrompt: () => undefined,
  seed: () => undefined,
  denoise: () => undefined,
  musicDescription: () => undefined,
  lyrics: () => undefined,
};

/**
 * Apply registered fingerprints to a graph snapshot. Keys without a
 * fingerprint pass through unchanged; keys whose fingerprint returns
 * `undefined` are dropped from the result.
 */
export function applyWhatIfFingerprints(
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    const fingerprint = whatIfFingerprints[key];
    if (fingerprint) {
      const fp = fingerprint(value);
      if (fp === undefined) continue;
      result[key] = fp;
    } else {
      result[key] = value;
    }
  }
  return result;
}
