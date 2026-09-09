import { isBaseModelGenerationSupported } from './basemodel.constants';
import { isGenerationDisabled } from './model-version-flags.constants';
import type { ModelType } from '@civitai/db-schema/enums';

/**
 * Whether a model version may generate: covered in the database, not generation-disabled, and the
 * ecosystem supports this MODEL TYPE.
 *
 * `covered` alone over-reports — the view's type branch is one flat list applied to every base
 * model. Neither half can answer alone, so this must be the only place they are composed;
 * `no-divergent-can-generate-derivation` keeps `isBaseModelGenerationSupported` out of `src/` and
 * carries the measurement.
 */
export function isGenerationEligible({
  covered,
  baseModel,
  modelType,
  flags,
}: {
  covered: boolean | null | undefined;
  baseModel: string;
  modelType: ModelType;
  /** ModelVersion.flags — carries the GenerationDisabled bit. */
  flags: number;
}): boolean {
  return (
    !!covered &&
    !isGenerationDisabled(flags) &&
    isBaseModelGenerationSupported(baseModel, modelType)
  );
}
