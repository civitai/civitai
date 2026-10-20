// The models a moderator may pick for a question, and what a day of them costs. Client-safe: the page
// renders the picker and the spend line from this, and the server refuses any id not in it.

export type AssistantModel = {
  /** OpenRouter's id. Each one was checked to route with tools under `data_collection: 'deny'`. */
  id: string;
  label: string;
  /** OpenRouter's LIST price, USD per million tokens. The router picks the provider per call, so what
   *  a turn really cost can differ; the page says "estimated at list prices" for that reason. */
  price: { input: number; output: number };
  /** No provider of it accepts `temperature`. Sent anyway, `require_parameters` finds no endpoint. */
  noTemperature?: true;
};

export const ASSISTANT_MODELS: readonly AssistantModel[] = [
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', price: { input: 0.048, output: 0.16 } },
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
};

/** A day's spend, per model and in total, at list prices. Unpriced models are left out of the total. */
export function estimateSpend(
  rows: { model: string; promptTokens: number; completionTokens: number }[]
): { usd: number; byModel: ModelSpend[] } {
  const byModel = rows.map((r): ModelSpend => {
    const m = findModel(r.model);
    return {
      ...r,
      label: m?.label ?? r.model,
      usd: m
        ? (r.promptTokens * m.price.input + r.completionTokens * m.price.output) / 1_000_000
        : null,
    };
  });
  return { usd: byModel.reduce((sum, r) => sum + (r.usd ?? 0), 0), byModel };
}
