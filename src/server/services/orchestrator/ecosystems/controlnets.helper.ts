/**
 * Shared helper for mapping the graph's `controlNets` value into the
 * `ImageJobControlNet[]` shape the orchestrator expects on `textToImage` /
 * compatible step inputs.
 */

import type { ImageJobControlNet, ImageTransformer } from '@civitai/client';
import type { ControlNetsNodeValue } from '~/shared/data-graph/generation/common';

/**
 * Convert the validated `controlNets` graph value to the orchestrator's
 * `ImageJobControlNet[]`. Returns `undefined` when there are no entries so
 * callers can spread it into step inputs without sending an empty array.
 *
 * The graph value already validates `image.url`, weight/step bounds, and
 * the preprocessor key against the per-ecosystem allow-list — so this
 * mapping is purely shape translation.
 */
export function mapControlNetsToJobInput(
  controlNets: ControlNetsNodeValue | undefined
): ImageJobControlNet[] | undefined {
  if (!controlNets?.length) return undefined;
  return controlNets.map((entry) => ({
    preprocessor: entry.preprocessor as ImageTransformer,
    weight: entry.weight,
    startStep: entry.startStep,
    endStep: entry.endStep,
    image: entry.image.url,
  }));
}
