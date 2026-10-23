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
 * Everywhere a refusal can hide on one thrown error, joined.
 *
 * 🔴 `.message` alone is NOT enough, and testing it against a hand-written `new Error(...)` is how
 * that went unnoticed. An `@openrouter/sdk` `ChatError` builds its message from `error.message`,
 * which for a refused pair is the entirely generic "Provider returned error"; the actual
 * `data_inspection_failed` sits in the raw HTTP body on `.body` (and the identical `.data$.body$`).
 * A fixture that puts the token in the message matches a regex the live provider never satisfies.
 *
 * The whole-object stringify at the end is the backstop for a provider that nests it somewhere
 * else again. It can only ever cost a needless reroute to a judge that would have answered anyway.
 */
function serializeError(error: unknown): string {
  if (error == null) return '';
  if (typeof error !== 'object') return String(error);

  const e = error as { message?: unknown; body?: unknown; data$?: { body$?: unknown } };
  return [e.message, e.body, e.data$?.body$, safeStringify(error)]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n');
}

// Error's own fields are non-enumerable (hence `.message` being listed separately above), and
// rawResponse/request$/response$ are both cyclic and useless here.
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, item) => {
        if (typeof item !== 'object' || item === null) return item;
        if (seen.has(item)) return undefined;
        seen.add(item);
        const name = item.constructor?.name;
        if (name === 'Request' || name === 'Response' || name === 'Headers') return undefined;
        return item;
      }) ?? ''
    );
  } catch {
    return '';
  }
}

/** A provider declining to look at the images, as opposed to any other failure. */
export function isContentRefusal(error: unknown): boolean {
  return REFUSAL_PATTERN.test(serializeError(error));
}
