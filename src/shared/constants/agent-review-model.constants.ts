/**
 * Choosing the model an App Blocks agent review runs on.
 *
 * A moderator can re-run a review on any tool-capable OpenRouter model (a second opinion, or a
 * way round a model that stopped working). The id they pick reaches the review agent as an
 * environment value, so it is held to a strict shape here, shared by the tRPC input schema, the
 * provisioning service and the client's inline validation. Keep this module free of zod, Prisma
 * and React so all three can import it.
 */

/** Longest OpenRouter model id accepted. Real ids are well under this. */
export const AGENT_REVIEW_MODEL_ID_MAX = 128;

/**
 * An OpenRouter model id: `<vendor>/<model>`, lower-case, with an optional `:variant` suffix
 * (e.g. `anthropic/claude-haiku-4.5`, `openai/gpt-4o-mini:free`). No spaces, quotes, `$` or
 * other characters that could change meaning where the id is substituted.
 */
export const AGENT_REVIEW_MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/;

export function isAgentReviewModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= AGENT_REVIEW_MODEL_ID_MAX &&
    AGENT_REVIEW_MODEL_ID_RE.test(value)
  );
}

/**
 * The review agent names its model with the gateway's `openrouter/` prefix, and that is the form
 * it writes to a report's `model` column. A chosen model is passed and stored in the same form,
 * so a report's model reads the same whoever picked it.
 */
export const AGENT_REVIEW_RUNNER_MODEL_PREFIX = 'openrouter/';

export function toRunnerModelId(openRouterId: string): string {
  return `${AGENT_REVIEW_RUNNER_MODEL_PREFIX}${openRouterId}`;
}

/**
 * The OpenRouter id inside a stored `openrouter/<id>` model, or `null` when the stored value is
 * not in that form or the id is not one this surface accepts.
 */
export function fromRunnerModelId(stored: string): string | null {
  if (!stored.startsWith(AGENT_REVIEW_RUNNER_MODEL_PREFIX)) return null;
  const id = stored.slice(AGENT_REVIEW_RUNNER_MODEL_PREFIX.length);
  return isAgentReviewModelId(id) ? id : null;
}

/**
 * The dearest INPUT price (USD per million tokens) a moderator may run a review on.
 *
 * The per-run cost cap is checked between analyses, so it can stop a later analysis from starting
 * but not the ones already running: a review's spend can overshoot the cap by whatever its first
 * analyses cost. Input dominates that spend (an analysis reads the whole bundle), so a ceiling on
 * the input price bounds the overshoot. $5/M admits the cheap models and the Haiku- and
 * Sonnet-class ones.
 */
export const AGENT_REVIEW_MODEL_MAX_PROMPT_PER_M = 5;

/** Whether a model's input price is within {@link AGENT_REVIEW_MODEL_MAX_PROMPT_PER_M}. */
export function isWithinAgentReviewPriceCeiling(option: { promptPerM: number }): boolean {
  return option.promptPerM <= AGENT_REVIEW_MODEL_MAX_PROMPT_PER_M;
}

/** One entry of the moderator's model picker. Prices are USD per million tokens. */
export type AgentReviewModelOption = {
  id: string;
  name: string;
  promptPerM: number;
  completionPerM: number;
};

/** `$0.14 / $0.28 per M` — the picker's price label. */
export function formatModelPricePerM(
  option: Pick<AgentReviewModelOption, 'promptPerM' | 'completionPerM'>
) {
  const fmt = (n: number) => `$${Number(n.toFixed(4))}`;
  return `${fmt(option.promptPerM)} in / ${fmt(option.completionPerM)} out per M`;
}
