import { TRPCError } from '@trpc/server';
import { outboundFetch } from '~/server/utils/fetch-timeout';
import { createTtlMemo } from '~/server/utils/ttl-memoize';
import {
  isAgentReviewModelId,
  type AgentReviewModelOption,
} from '~/shared/constants/agent-review-model.constants';

/**
 * The models a moderator can re-run an agent review on: OpenRouter's public model list,
 * narrowed to the models that accept tool calls (the review agent's analyses are tool chains).
 *
 * The list is public and needs no key. It is cached per process for
 * {@link AGENT_REVIEW_MODELS_TTL_MS}: it changes a few times a day at most, it is the same for
 * every moderator, and only moderators re-running a review ever ask for it.
 */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** How stale the cached model list may be. */
export const AGENT_REVIEW_MODELS_TTL_MS = 30 * 60 * 1000;

const FETCH_TIMEOUT_MS = 10_000;

/** USD per token (OpenRouter's unit, as a decimal string) → USD per million tokens. */
function perMillion(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = Number(raw);
  // OpenRouter prices a few routers as "-1" (decided per request). Those cannot be costed up
  // front, so they cannot be offered: the per-run cost cap needs a known price.
  if (!Number.isFinite(n) || n < 0) return null;
  // Rounded to a micro-dollar per million so 0.00000014 reads 0.14, not 0.13999999999999999.
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

/**
 * Narrow OpenRouter's `/models` response to tool-capable models with a known price, in the
 * picker's shape, sorted by name. Anything malformed is skipped rather than failing the list.
 */
export function parseToolCapableModels(body: unknown): AgentReviewModelOption[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: AgentReviewModelOption[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const m = entry as Record<string, unknown>;
    const params = m.supported_parameters;
    if (!Array.isArray(params) || !params.includes('tools')) continue;
    if (!isAgentReviewModelId(m.id)) continue;
    const pricing = (m.pricing ?? {}) as Record<string, unknown>;
    const promptPerM = perMillion(pricing.prompt);
    const completionPerM = perMillion(pricing.completion);
    if (promptPerM == null || completionPerM == null) continue;
    const contextLength =
      typeof m.context_length === 'number' && Number.isFinite(m.context_length)
        ? m.context_length
        : null;
    out.push({
      id: m.id,
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 200) : m.id,
      promptPerM,
      completionPerM,
      contextLength,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchToolCapableModels(): Promise<AgentReviewModelOption[]> {
  const res = await outboundFetch(OPENROUTER_MODELS_URL, {
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`OpenRouter model list returned ${res.status}`);
  const models = parseToolCapableModels(await res.json());
  // An empty list is a broken response, not "no models exist": do not cache it.
  if (models.length === 0) throw new Error('OpenRouter model list had no tool-capable models');
  return models;
}

/** The cached, tool-capable model list. Rejects (and caches nothing) when OpenRouter is unreachable. */
export const getAgentReviewModelOptions = createTtlMemo(
  fetchToolCapableModels,
  AGENT_REVIEW_MODELS_TTL_MS,
  Date.now,
  { freeze: true }
);

/**
 * The listed entry for a model a moderator chose, with its price.
 *
 * The price is what keeps the per-run cost cap honest: the review agent estimates its spend from
 * token counts and a per-model price, so a model it is not given a price for would be costed at
 * the default model's rate. A model OpenRouter does not list as tool-capable, or a list that
 * cannot be fetched, is therefore refused rather than run unpriced.
 */
export async function resolveAgentReviewModel(id: string): Promise<AgentReviewModelOption> {
  let models: readonly AgentReviewModelOption[];
  try {
    models = await getAgentReviewModelOptions();
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        "Could not load OpenRouter's model list to price this model, so the cost cap could not be applied. Try again, or leave the model blank to use the default.",
    });
  }
  const found = models.find((m) => m.id === id);
  if (!found) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `"${id}" is not a tool-capable model on OpenRouter. Pick one from the list, or leave the model blank to use the default.`,
    });
  }
  return found;
}
