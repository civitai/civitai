import { minimaxVersionIds } from '~/shared/generation/version-ids';

/**
 * Where a mature source image is pointed instead of Flux 3 Video. The self-hosted build, not the
 * hosted or Max ones: those run behind a provider content filter of their own.
 */
export const MATURE_SOURCE_ALTERNATIVE = {
  ecosystem: 'MiniMaxH3',
  modelId: minimaxVersionIds.comfy,
  label: 'MiniMax H3',
} as const;

export const FLUX3_MATURE_SOURCE_MESSAGE = `Flux 3 Video can't animate images rated above PG-13: its provider rejects them. Try ${MATURE_SOURCE_ALTERNATIVE.label} instead.`;

/** Added to a provider refusal, which does not say whether the image, the prompt or the output tripped it. */
export const MATURE_SOURCE_HINT = `If your source image is rated above PG-13, try ${MATURE_SOURCE_ALTERNATIVE.label} instead.`;

/** Shown when the orchestrator held a run to PG-13 because its source image carries no generation stamp. */
export const UNMARKED_SOURCE_IMAGE_MESSAGE =
  "This source image doesn't show it was generated, so results are limited to PG-13. If it's a Civitai image, use its Download button or drag it in from the site; saved or copied images lose that information.";
