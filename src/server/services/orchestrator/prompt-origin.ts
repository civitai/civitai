import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import { MAX_SOURCE_IMAGES } from '~/server/utils/source-image-ids';
import {
  PROMPT_ENHANCEMENT_TAGS,
  findPromptEnhancementStep,
} from '~/shared/constants/prompt-enhancement.constants';
import { promptDerivationHolds } from '~/utils/prompt-similarity';
import type { BlockedPromptEntry } from '~/server/services/orchestrator/promptAuditing';

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
    // Read from the user's own workflows, which they can modify, so never server-verified.
    verified: false;
  };
  /** A lookup failed or timed out: missing evidence is not evidence of absence. */
  incomplete?: true;
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
const LOOKUP_TIMEOUT_MS = 800;
const ENHANCER_HISTORY_SIZE = 5;

const MATCH_RANK: Record<PromptMatch, number> = {
  identical: 3,
  edited: 2,
  unrelated: 1,
  unknown: 0,
};

const TIMED_OUT = Symbol('origin lookup timed out');

/** Resolves to `TIMED_OUT` rather than hanging; a late rejection is reaped by the helper. */
function bounded<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
  return withTimeoutFallback<T | typeof TIMED_OUT>(work, LOOKUP_TIMEOUT_MS, TIMED_OUT);
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

function comparePrompts(source: string, submitted: string) {
  if (normalize(source) === normalize(submitted)) return { match: 'identical' as const, score: 1 };
  const { holds, score } = promptDerivationHolds(source, submitted);
  return { match: holds ? ('edited' as const) : ('unrelated' as const), score };
}

type Lookup<T> = { value?: T; incomplete?: true };

async function remixOrigin(
  prompt: string,
  sourceImageIds: number[] | undefined,
  remixOfId: number | undefined
): Promise<Lookup<NonNullable<PromptOrigin['remix']>>> {
  const verified = (sourceImageIds ?? []).length > 0;
  const candidates = verified
    ? [...new Set(sourceImageIds)].slice(0, MAX_SOURCE_IMAGES)
    : remixOfId
    ? [remixOfId]
    : [];
  if (!candidates.length) return {};

  let metas: Record<number, { meta?: unknown } | undefined> = {};
  let incomplete = false;
  try {
    const { imageMetaCache } = await import('~/server/redis/caches');
    const fetched = await bounded(imageMetaCache.fetch(candidates));
    if (fetched === TIMED_OUT) incomplete = true;
    else metas = fetched;
  } catch {
    incomplete = true;
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
  return { value: best, ...(incomplete ? { incomplete: true as const } : {}) };
}

async function enhancerOrigin(
  prompt: string,
  token: string
): Promise<Lookup<NonNullable<PromptOrigin['enhancer']>>> {
  try {
    const { queryWorkflows } = await import('~/server/services/orchestrator/workflows');
    const result = await bounded(
      queryWorkflows({
        token,
        tags: PROMPT_ENHANCEMENT_TAGS,
        take: ENHANCER_HISTORY_SIZE,
        hideMatureContent: false,
      })
    );
    if (result === TIMED_OUT) return { incomplete: true };

    let best: NonNullable<PromptOrigin['enhancer']> | undefined;
    for (const workflow of result.items ?? []) {
      const step = findPromptEnhancementStep(
        workflow as { steps?: Array<{ $type?: string; name?: string }> }
      ) as { output?: { enhancedPrompt?: unknown } } | undefined;
      const enhanced = step?.output?.enhancedPrompt;
      if (typeof enhanced !== 'string' || !enhanced.trim()) continue;
      const { match } = comparePrompts(enhanced, prompt);
      if (match === 'unrelated') continue;
      if (match === 'identical') {
        return { value: { workflowId: workflow.id, promptMatch: 'identical', verified: false } };
      }
      best ??= { workflowId: workflow.id, promptMatch: 'edited', verified: false };
    }
    return { value: best };
  } catch {
    return { incomplete: true };
  }
}

/**
 * Where a blocked prompt came from, as far as the server can tell. Never throws: a failed or
 * timed-out lookup keeps what was found and sets `incomplete`, and the audit verdict is unaffected.
 */
export async function buildPromptOrigin({
  prompt,
  sourceImageIds,
  remixOfId,
  token,
}: BuildPromptOriginOptions): Promise<PromptOrigin> {
  try {
    const [remix, enhancer] = await Promise.all([
      remixOrigin(prompt, sourceImageIds, remixOfId).catch(
        (): Lookup<never> => ({ incomplete: true })
      ),
      token ? enhancerOrigin(prompt, token) : ({} as Lookup<never>),
    ]);
    return {
      ...(remix.value ? { remix: remix.value } : {}),
      ...(enhancer.value ? { enhancer: enhancer.value } : {}),
      ...(remix.incomplete || enhancer.incomplete ? { incomplete: true as const } : {}),
    };
  } catch {
    return { incomplete: true };
  }
}

/** Origin for a row rebuilt from the audit log, where only `remixOfId` survives. */
export function backfilledPromptOrigin(remixOfId?: number | null): PromptOrigin | undefined {
  if (!remixOfId) return undefined;
  return { remix: { imageId: remixOfId, verified: false, promptMatch: 'unknown' } };
}

type ProhibitedRequestRow = {
  prompt: string;
  negativePrompt: string | null;
  source: string;
  remixOfId: number | null;
  inputImages: string[] | null;
  inputVideo: string | null;
  createdDate: string;
};

/** A stored audit-log row as a trigger entry; `match` is the first regex hit from re-auditing it. */
export function prohibitedRowToTrigger(
  row: ProhibitedRequestRow,
  match?: { check?: string; matchedText?: string; regex?: string }
): BlockedPromptEntry {
  return {
    prompt: row.prompt,
    negativePrompt: row.negativePrompt ?? '',
    source: row.source,
    category: match?.check as BlockedPromptEntry['category'],
    matchedWord: match?.matchedText,
    matchedRegex: match?.regex,
    imageId: null,
    remixOfId: null,
    inputImages: row.inputImages?.length ? row.inputImages : undefined,
    inputVideo: row.inputVideo || undefined,
    origin: backfilledPromptOrigin(row.remixOfId),
    time: row.createdDate,
  };
}
