import { isBaseModelGenerationSupported, isModelLockedBaseModel } from './basemodel.constants';
import { isGenerationDisabled } from './model-version-flags.constants';
import type { ModelType } from '@civitai/db-schema/enums';

/**
 * Whether a model version may generate: covered in the database, not generation-disabled, and the
 * ecosystem supports this MODEL TYPE. A checkpoint on a `modelLocked` ecosystem is held to the live
 * coverage column — see `effectiveCoverage`.
 *
 * `covered` alone over-reports — the view's type branch is one flat list applied to every base
 * model. Neither half can answer alone, so this must be the only place they are composed;
 * `no-divergent-can-generate-derivation` keeps both constants-side helpers out of `src/` and
 * carries the measurement.
 */
export function isGenerationEligible({
  covered,
  coveredLive,
  baseModel,
  modelType,
  flags,
}: {
  covered: boolean | null | undefined;
  /**
   * Always `GenerationCoverage.covered`, never `coveredNext` — a checkpoint on a `modelLocked`
   * ecosystem is held to it, so an optional parameter would silently refuse every one of them.
   */
  coveredLive: boolean | null | undefined;
  baseModel: string;
  modelType: ModelType;
  /** ModelVersion.flags — carries the GenerationDisabled bit. */
  flags: number;
}): boolean {
  return (
    !!effectiveCoverage({ covered, coveredLive, baseModel, modelType }) &&
    !isGenerationDisabled(flags) &&
    isBaseModelGenerationSupported(baseModel, modelType)
  );
}

/**
 * The staged expansion exists to download a COMMUNITY checkpoint on demand, and a `modelLocked`
 * ecosystem has no such thing (see `isModelLockedBaseModel`) — the site was selling a load for
 * weights the graph would never reference. Those answer under the live column instead.
 *
 * Keyed on the live COLUMN rather than `EcosystemCheckpoints` directly, so it still honours an
 * auction slot someone paid for.
 */
function effectiveCoverage({
  covered,
  coveredLive,
  baseModel,
  modelType,
}: {
  covered: boolean | null | undefined;
  coveredLive: boolean | null | undefined;
  baseModel: string;
  modelType: ModelType;
}) {
  if (modelType !== 'Checkpoint' || !isModelLockedBaseModel(baseModel)) return covered;
  return coveredLive;
}
