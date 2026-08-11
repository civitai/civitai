import { AI_MODELS, type AIModel } from '~/server/services/ai/openrouter';

/**
 * Judge selection for pairwise comparisons. A pair is judged by the first route whose ceiling
 * covers it, so swapping a model or moving the adult threshold is an edit to this array and
 * nothing else.
 *
 * Routing is per PAIR, never per entry: a comparison needs one judge that can see both images.
 *
 * `pickClient` in generative-content.ts dispatches `urn:air:*` to the orchestrator client, so a
 * self-hosted route is a model string here with no other plumbing.
 */
export const JUDGE_ROUTES = [
  { maxNsfwLevel: 4, model: AI_MODELS.QWEN_FLASH },
  { maxNsfwLevel: 32, model: AI_MODELS.GPT_5_6_LUNA },
] as const;

/**
 * Where a refused pair goes. Must be the widest route in the table — a cheap judge declining on
 * content has to be answered by a judge that will look at it, not by dropping the entry.
 */
export const PERMISSIVE_JUDGE: AIModel = JUDGE_ROUTES[JUDGE_ROUTES.length - 1].model;

/** The judge for a pair, chosen by the HIGHER nsfwLevel of the two images. */
export function pickJudge(pairMaxNsfwLevel: number): AIModel {
  const route = JUDGE_ROUTES.find((r) => pairMaxNsfwLevel <= r.maxNsfwLevel);
  return route?.model ?? PERMISSIVE_JUDGE;
}

const REFUSAL_PATTERN =
  /data_inspection_failed|inappropriate[_ ]content|content[_ ]policy|content[_ ]filter|flagged by/i;

/**
 * A provider declining to look at the images, as opposed to any other failure. Matched on the
 * message because the refusal arrives as an HTTP error body, not a typed field.
 */
export function isContentRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return REFUSAL_PATTERN.test(message);
}
