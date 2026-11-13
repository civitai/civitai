// The models a moderator may pick for a question, and what a day of them costs. Client-safe: the page
// renders the picker and the spend line from this, and the server refuses any id not in it.

/** USD per million tokens. `current`: read from OpenRouter's list just now, not the release's copy. */
export type Price = { input: number; output: number; current?: boolean };

export type AssistantModel = {
  /** OpenRouter's id. Each one was checked to route with tools under `data_collection: 'deny'`. */
  id: string;
  label: string;
  /** OpenRouter's list price, USD per million tokens, as of this release. Only a fallback: list prices
   *  move (Flash's tripled within hours), so the server reads the live list (`listPrices`). */
  price: Price;
  /** No provider of it accepts `temperature`. Sent anyway, `require_parameters` finds no endpoint. */
  noTemperature?: true;
};

// Adding a model adds a processor that receives moderation context, so it needs the Moderation Lead's
// (or Justin's) approval first, not only a live routing check.
export const ASSISTANT_MODELS: readonly AssistantModel[] = [
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', price: { input: 0.15, output: 0.5 } },
  { id: 'z-ai/glm-5.3', label: 'GLM 5.3', price: { input: 0.079, output: 1.4 } },
  { id: 'stepfun/step-5-preview', label: 'Step 5 Preview', price: { input: 1, output: 2.7 } },
  {
    id: 'openai/gpt-6-luna',
    label: 'GPT-6 Luna',
    price: { input: 0.1, output: 0.5 },
    noTemperature: true,
  },
];

export const DEFAULT_ASSISTANT_MODEL = 'z-ai/glm-5.3-flash';

export const findModel = (id: string | null | undefined) =>
  ASSISTANT_MODELS.find((m) => m.id === id) ?? null;

export type ModelSpend = {
  model: string;
  label: string;
  promptTokens: number;
  completionTokens: number;
  /** Null for a model no longer in the list, whose price is not known here. */
  usd: number | null;
  /** Priced from OpenRouter's current list; false when the release's copy stood in. */
  current: boolean;
};

export type TokenRow = { model: string; promptTokens: number; completionTokens: number };

/**
 * A day's spend, per model and in total, at the given prices (the release's copy by default). A model
 * with no price is left out of the total, and `unpricedTokens` says how much was left out, so the page
 * can say the total is short rather than show a smaller number as if it were complete. `current` is
 * false when any priced row used the release's copy, so the page can say the prices are not today's.
 */
export function estimateSpend(
  rows: TokenRow[],
  prices: Record<string, Price> = Object.fromEntries(ASSISTANT_MODELS.map((m) => [m.id, m.price]))
): { usd: number; byModel: ModelSpend[]; unpricedTokens: number; current: boolean } {
  const byModel = rows.map((r): ModelSpend => {
    const price = prices[r.model];
    return {
      ...r,
      label: findModel(r.model)?.label ?? r.model,
      usd: price
        ? (r.promptTokens * price.input + r.completionTokens * price.output) / 1_000_000
        : null,
      current: !!price?.current,
    };
  });
  return {
    usd: byModel.reduce((sum, r) => sum + (r.usd ?? 0), 0),
    byModel,
    unpricedTokens: byModel
      .filter((r) => r.usd === null)
      .reduce((sum, r) => sum + r.promptTokens + r.completionTokens, 0),
    current: byModel.every((r) => r.usd === null || r.current),
  };
}

/** The dearest listed input and output prices: what the cap charges for a model it cannot price. */
export const CEILING_PRICE: Price = {
  input: Math.max(...ASSISTANT_MODELS.map((m) => m.price.input)),
  output: Math.max(...ASSISTANT_MODELS.map((m) => m.price.output)),
};

/**
 * The price the dollar cap charges a model at: the higher of OpenRouter's live price and the release's
 * list price, per direction, so a live price read low (or wrong) can never make a turn cheaper than the
 * list says. A model not in the list is charged `CEILING_PRICE`, never $0. `source` is `live` when a live
 * price was read and taken into account.
 */
export function capPrice(
  model: string,
  prices: Record<string, Price>
): { price: Price; source: 'live' | 'list' } {
  const list = findModel(model)?.price;
  if (!list) return { price: CEILING_PRICE, source: 'list' };
  const live = prices[model];
  if (!live?.current) return { price: { input: list.input, output: list.output }, source: 'list' };
  return {
    price: { input: Math.max(live.input, list.input), output: Math.max(live.output, list.output) },
    source: 'live',
  };
}

export const costUsd = (promptTokens: number, completionTokens: number, price: Price) =>
  (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
