import { logToAxiom } from '~/server/logging/client';
import { sysRedis } from '~/server/redis/client';
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

// The lookups run after the response, so this only has to stay under the orchestrator read's own
// backstop, which is longer than the typical workflow query.
const LOOKUP_TIMEOUT_MS = 10_000;
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
      const workflowId = workflow.id;
      if (!workflowId) continue;
      const step = findPromptEnhancementStep(
        workflow as { steps?: Array<{ $type?: string; name?: string }> }
      ) as { output?: { enhancedPrompt?: unknown } } | undefined;
      const enhanced = step?.output?.enhancedPrompt;
      if (typeof enhanced !== 'string' || !enhanced.trim()) continue;
      const { match } = comparePrompts(enhanced, prompt);
      if (match === 'unrelated') continue;
      if (match === 'identical') {
        return { value: { workflowId, promptMatch: 'identical', verified: false } };
      }
      best ??= { workflowId, promptMatch: 'edited', verified: false };
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

/** How a list element is recognised: the `id` key as `JSON.stringify` writes it into the stored entry. */
export const blockedEntryIdNeedle = (id: string) => `"id":${JSON.stringify(id)}`;

// The entry was pushed to the head moments before this runs, so only the head is scanned: the list
// is otherwise unbounded and Redis runs the script single-threaded.
const ORIGIN_SCAN_HEAD = 50;

// Finds the element by id and swaps it for the new JSON in one step: the list is pushed to
// concurrently, so an index read in Node would be stale by the time of the LSET. The id is a
// server-generated UUID, so a plain substring match on the serialized element cannot collide.
export const REPLACE_ENTRY_BY_ID = `
  local items = redis.call('LRANGE', KEYS[1], 0, ${ORIGIN_SCAN_HEAD - 1})
  for i, raw in ipairs(items) do
    if string.find(raw, ARGV[1], 1, true) then
      redis.call('LSET', KEYS[1], i - 1, ARGV[2])
      return 1
    end
  end
  return 0
`;

// A mute can read the list before the entry's origin is written and file its row a moment later.
const ATTACH_RETRY_DELAY_MS = 2_000;

export type AttachPromptOriginOptions = BuildPromptOriginOptions & {
  userId: number;
  entry: BlockedPromptEntry & { id: string };
  redisKey: string;
};

/**
 * Looks up where a stored blocked prompt came from and writes it onto that entry, in the Redis list
 * or, once a mute has moved the list into a restriction row, in the row. Meant to be fire-and-forget:
 * it never throws, and an attach that is dropped leaves the entry as `incomplete`.
 */
export async function attachPromptOrigin({
  userId,
  entry,
  redisKey,
  ...lookup
}: AttachPromptOriginOptions): Promise<void> {
  try {
    const origin = await buildPromptOrigin(lookup);

    const attempt = async (): Promise<boolean> => {
      try {
        const replaced = await sysRedis.eval(REPLACE_ENTRY_BY_ID, {
          keys: [redisKey],
          arguments: [blockedEntryIdNeedle(entry.id), JSON.stringify({ ...entry, origin })],
        });
        if (Number(replaced) === 1) return true;

        const { replaceTriggerOrigin } = await import('~/server/services/user-restriction.service');
        return (await replaceTriggerOrigin({ userId, entryId: entry.id, origin })) > 0;
      } catch (e) {
        logAttachError(e, userId);
        return false;
      }
    };

    if (await attempt()) return;
    await new Promise((resolve) => setTimeout(resolve, ATTACH_RETRY_DELAY_MS));
    await attempt();
  } catch (e) {
    logAttachError(e, userId);
  }
}

function logAttachError(e: unknown, userId: number) {
  logToAxiom({
    name: 'prompt-origin-attach-error',
    type: 'error',
    message: (e as Error)?.message,
    details: { userId },
  });
}
