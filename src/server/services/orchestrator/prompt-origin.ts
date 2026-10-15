import { promptDerivationHolds } from '~/utils/prompt-similarity';

export type PromptMatch = 'identical' | 'edited' | 'unrelated' | 'unknown';

export type PromptOrigin = {
  remix?: {
    imageId: number;
    verified: boolean;
    promptMatch: PromptMatch;
    score?: number;
  };
  enhancer?: {
    workflowId: string;
    promptMatch: 'identical' | 'edited';
  };
};

export type BuildPromptOriginOptions = {
  prompt: string;
  sourceImageIds?: number[];
  remixOfId?: number;
  token?: string;
};

// The cache and workflow clients are imported lazily: they pull in the whole redis/orchestrator
// graph, which only a blocked request needs.

// This runs on the block path of a request, so each lookup is cut off well inside the request's budget.
const LOOKUP_TIMEOUT_MS = 1500;
const MAX_REMIX_CANDIDATES = 5;
const ENHANCER_HISTORY_SIZE = 5;
const ENHANCER_TAGS = ['prompt-enhancement'];

const MATCH_RANK: Record<PromptMatch, number> = {
  identical: 3,
  edited: 2,
  unrelated: 1,
  unknown: 0,
};

function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('origin lookup timed out')), LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

function comparePrompts(source: string, submitted: string) {
  if (normalize(source) === normalize(submitted)) return { match: 'identical' as const, score: 1 };
  const { holds, score } = promptDerivationHolds(source, submitted);
  return { match: holds ? ('edited' as const) : ('unrelated' as const), score };
}

async function remixOrigin(
  prompt: string,
  sourceImageIds: number[] | undefined,
  remixOfId: number | undefined
): Promise<PromptOrigin['remix']> {
  const verified = (sourceImageIds ?? []).length > 0;
  const candidates = verified
    ? [...new Set(sourceImageIds)].slice(0, MAX_REMIX_CANDIDATES)
    : remixOfId
    ? [remixOfId]
    : [];
  if (!candidates.length) return undefined;

  let metas: Record<number, { meta?: unknown } | undefined> = {};
  try {
    const { imageMetaCache } = await import('~/server/redis/caches');
    metas = await bounded(imageMetaCache.fetch(candidates));
  } catch {
    // fall through: every candidate is unknown
  }

  let best: NonNullable<PromptOrigin['remix']> | undefined;
  for (const imageId of candidates) {
    const sourcePrompt = (metas[imageId]?.meta as { prompt?: unknown } | null | undefined)?.prompt;
    const compared =
      typeof sourcePrompt === 'string' && sourcePrompt.trim()
        ? comparePrompts(sourcePrompt, prompt)
        : undefined;
    const entry = {
      imageId,
      verified,
      promptMatch: compared?.match ?? ('unknown' as PromptMatch),
      ...(compared ? { score: compared.score } : {}),
    };
    if (!best || MATCH_RANK[entry.promptMatch] > MATCH_RANK[best.promptMatch]) best = entry;
  }
  return best;
}

async function enhancerOrigin(prompt: string, token: string): Promise<PromptOrigin['enhancer']> {
  try {
    const { queryWorkflows } = await import('~/server/services/orchestrator/workflows');
    const { items } = await bounded(
      queryWorkflows({
        token,
        tags: ENHANCER_TAGS,
        take: ENHANCER_HISTORY_SIZE,
        hideMatureContent: false,
      })
    );
    let best: PromptOrigin['enhancer'];
    for (const workflow of items ?? []) {
      const steps =
        (
          workflow as {
            steps?: Array<{ $type?: string; name?: string; output?: { enhancedPrompt?: unknown } }>;
          }
        ).steps ?? [];
      const step = steps.find(
        (s) => s.$type === 'promptEnhancement' || s.name === ENHANCER_TAGS[0]
      );
      const enhanced = step?.output?.enhancedPrompt;
      if (typeof enhanced !== 'string' || !enhanced.trim()) continue;
      const { match } = comparePrompts(enhanced, prompt);
      if (match === 'unrelated') continue;
      if (match === 'identical') return { workflowId: workflow.id, promptMatch: 'identical' };
      best ??= { workflowId: workflow.id, promptMatch: 'edited' };
    }
    return best;
  } catch {
    return undefined;
  }
}

/**
 * Where a blocked prompt came from, as far as the server can tell. Never throws: a failed or
 * timed-out lookup degrades to `unknown` or to an empty origin, and the audit verdict is unaffected.
 */
export async function buildPromptOrigin({
  prompt,
  sourceImageIds,
  remixOfId,
  token,
}: BuildPromptOriginOptions): Promise<PromptOrigin> {
  try {
    const [remix, enhancer] = await Promise.all([
      remixOrigin(prompt, sourceImageIds, remixOfId).catch(() => undefined),
      token ? enhancerOrigin(prompt, token) : undefined,
    ]);
    return { ...(remix ? { remix } : {}), ...(enhancer ? { enhancer } : {}) };
  } catch {
    return {};
  }
}

/** Origin for a row rebuilt from the audit log, where only `remixOfId` survives. */
export function backfilledPromptOrigin(remixOfId?: number | null): PromptOrigin | undefined {
  if (!remixOfId) return undefined;
  return { remix: { imageId: remixOfId, verified: false, promptMatch: 'unknown' } };
}
