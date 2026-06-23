import { CacheTTL, constants } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { createNotification } from '~/server/services/notification.service';
import { updateUserById } from '~/server/services/user.service';
import { fetchThroughCache, bustFetchThroughCache } from '~/server/utils/cache-helpers';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import {
  auditPromptEnriched,
  type PromptTrigger,
  type PromptTriggerCategory,
} from '~/utils/metadata/audit';
import { refreshSession } from '~/server/auth/session-invalidation';
import { externalModerationOutcomeCounter } from '~/server/prom/client';

// --- Blocked Prompt Store ---
// Single Redis list stores both count (list length) and prompt data.
// If key doesn't exist, seeds from ClickHouse. Uses a reset marker to
// distinguish "empty because reset" from "doesn't exist".

export interface BlockedPromptEntry {
  prompt: string;
  negativePrompt: string;
  source: string;
  category?: PromptTriggerCategory;
  matchedWord?: string;
  matchedRegex?: string;
  imageId: number | null;
  remixOfId: number | null;
  time: string;
}

// Window over which we count blocked-prompt attempts toward the auto-mute threshold.
// Doubles as the Redis TTL and as the ClickHouse seed window so that a cold start
// (key missing / sysRedis wipe) rebuilds the counter with the same horizon it would
// have had in steady state. Keeping these in lockstep prevents the previous behavior
// where many users effectively accumulated forever in Redis but only recovered the
// last 24h after a wipe.
const BLOCKED_PROMPTS_WINDOW_DAYS = 30;
const BLOCKED_PROMPTS_TTL = 60 * 60 * 24 * BLOCKED_PROMPTS_WINDOW_DAYS;
const RESET_MARKER = '__RESET__';

function getBlockedPromptsKey(userId: number) {
  return `${REDIS_SYS_KEYS.GENERATION.BLOCKED_PROMPTS}:${userId}` as const;
}

/** Seed the blocked prompts list from ClickHouse for the configured rolling window. */
async function seedBlockedPromptsFromClickHouse(userId: number): Promise<void> {
  const key = getBlockedPromptsKey(userId);
  const { clickhouse } = await import('~/server/clickhouse/client');

  if (!clickhouse) {
    // No ClickHouse available, set reset marker so we don't keep trying
    await sysRedis.lPush(key, RESET_MARKER);
    await sysRedis.expire(key, BLOCKED_PROMPTS_TTL);
    return;
  }

  const data = await clickhouse.$query<{
    prompt: string;
    negativePrompt: string;
    source: string;
    remixOfId: number | null;
    time: string;
  }>`
    SELECT prompt, negativePrompt, source, remixOfId, time
    FROM prohibitedRequests
    WHERE time > subtractDays(now(), ${BLOCKED_PROMPTS_WINDOW_DAYS}) AND userId = ${userId}
    ORDER BY time ASC
  `;

  if (data.length === 0) {
    // No violations today, set reset marker
    await sysRedis.lPush(key, RESET_MARKER);
  } else {
    // Add all violations (oldest first, so newest ends up at head)
    for (const row of data) {
      const entry: BlockedPromptEntry = {
        prompt: row.prompt,
        negativePrompt: row.negativePrompt,
        source: row.source,
        category: undefined,
        matchedWord: undefined,
        matchedRegex: undefined,
        imageId: null,
        remixOfId: row.remixOfId ?? null,
        time: row.time,
      };
      await sysRedis.rPush(key, JSON.stringify(entry));
    }
  }
  await sysRedis.expire(key, BLOCKED_PROMPTS_TTL);
}

/** Get blocked prompt count, seeding from ClickHouse if key doesn't exist */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function getBlockedPromptCount(userId: number): Promise<number> {
  const key = getBlockedPromptsKey(userId);
  const exists = await sysRedis.exists(key);

  if (!exists) {
    await seedBlockedPromptsFromClickHouse(userId);
  }

  const entries = await sysRedis.lRange(key, 0, -1);
  return entries.filter((e) => e !== RESET_MARKER).length;
}

/** Add a blocked prompt and return the new count */
async function addBlockedPrompt(userId: number, entry: BlockedPromptEntry): Promise<number> {
  const key = getBlockedPromptsKey(userId);
  const exists = await sysRedis.exists(key);

  if (!exists) {
    await seedBlockedPromptsFromClickHouse(userId);
  }

  // Push the new entry first so the list is never empty during cleanup —
  // an empty list would auto-delete the key in Redis and discard its TTL.
  await sysRedis.lPush(key, JSON.stringify(entry));

  // If the seeded list was just a reset marker, drop the marker now that we
  // have a real entry. Using lRem (not del) preserves the TTL set by the seed.
  const currentEntries = await sysRedis.lRange(key, 0, -1);
  if (currentEntries.includes(RESET_MARKER)) {
    await sysRedis.lRem(key, 0, RESET_MARKER);
  }

  // Marker has been removed above, so lLen now equals the real violation count.
  return await sysRedis.lLen(key);
}

/** Get all blocked prompts (excludes reset marker) */
async function getBlockedPrompts(userId: number): Promise<BlockedPromptEntry[]> {
  const key = getBlockedPromptsKey(userId);
  const entries = await sysRedis.lRange(key, 0, -1);
  return entries
    .filter((e) => e !== RESET_MARKER)
    .map((entry) => JSON.parse(entry) as BlockedPromptEntry);
}

/**
 * Reset a user's blocked prompts (e.g., when unmuting).
 * Sets to empty (reset marker) instead of deleting, so ClickHouse won't be queried again.
 */
export async function resetProhibitedRequestCount(userId: number) {
  const key = getBlockedPromptsKey(userId);
  await sysRedis.del(key);
  await sysRedis.lPush(key, RESET_MARKER);
  await sysRedis.expire(key, BLOCKED_PROMPTS_TTL);
}

/**
 * Clear blocked prompts after they've been stored in the DB (e.g., after muting).
 * Deletes the key entirely - different from reset which leaves a marker.
 */
async function clearBlockedPromptsAfterMute(userId: number) {
  const key = getBlockedPromptsKey(userId);
  await sysRedis.del(key);
}

// --- Prompt Allowlist Cache ---
// Caches the set of allowlisted (trigger, category) pairs used to filter out
// false positives from prompt auditing before counting toward mute thresholds.
type AllowlistEntry = { trigger: string; category: string };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function getCachedPromptAllowlist(): Promise<Set<string>> {
  const entries = await fetchThroughCache(
    REDIS_KEYS.SYSTEM.PROMPT_ALLOWLIST,
    async () => {
      const rows = await dbRead.promptAllowlist.findMany({
        select: { trigger: true, category: true },
      });
      return rows as AllowlistEntry[];
    },
    { ttl: CacheTTL.day }
  );
  // Build a Set of "trigger:category" keys for O(1) lookup
  return new Set(entries.map((e) => `${e.trigger}:${e.category}`));
}

/** Bust the prompt allowlist cache (call after adding/removing entries). */
export async function bustPromptAllowlistCache() {
  await bustFetchThroughCache(REDIS_KEYS.SYSTEM.PROMPT_ALLOWLIST);
}

/** Filter triggers against the allowlist, returning only non-allowlisted triggers. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function filterAllowlistedTriggers(
  triggers: PromptTrigger[],
  allowlist: Set<string>
): PromptTrigger[] {
  if (allowlist.size === 0) return triggers;
  return triggers.filter((t) => {
    if (!t.matchedWord) return true; // no specific word to match — keep it
    return !allowlist.has(`${t.matchedWord}:${t.category}`);
  });
}

// --- Deferred External-Moderation Re-Screen Queue ---
// The inline external moderation call (OpenAI omni-moderation) is FAIL-SOFT: when
// OpenAI is slow/down (intermittent 503/504 + >5s windows) the prompt's CSAM
// pre-screen is silently skipped on the hot path and never recovered. This queue
// captures those skips so the `rescreen-skipped-prompt-moderation` cron can re-screen
// them when OpenAI recovers and apply the SAME consequence as the inline path
// (mute escalation + audit record) — just delayed.
//
// Durability caveat: this rides on sysRedis (the same instance the blocked-prompt
// store uses). It is NOT a guaranteed-delivery broker — a sysRedis wipe loses pending
// items, and the cap below (FIFO eviction of the OLDEST unprocessed entries) can drop
// items under a sustained OpenAI outage that outpaces drain. Both are acceptable: this
// is a best-effort SECONDARY safety net layered on top of the primary regex audit, not
// the primary CSAM gate.
const RESCREEN_QUEUE_KEY = REDIS_SYS_KEYS.GENERATION.MODERATION_RESCREEN_QUEUE;
// FIFO queue: enqueue with rPush (append to tail), drain with lPopCount from the
// head — so the OLDEST skipped prompts are re-screened first (clear the backlog in
// order). Hard cap so a prolonged OpenAI outage can never grow it unbounded:
// lTrim(0, MAX-1) keeps the oldest MAX (the head) and evicts the NEWEST tail — and
// during an active outage the live path keeps enqueuing newest, so evicting newest
// loses the least (it'll be re-enqueued by ongoing traffic; the backlog we're
// draining is preserved).
const RESCREEN_QUEUE_MAX = 20000;
// TTL backstop so raw prompt text can never persist indefinitely in sysRedis if the
// drain cron stops (job-runner outage / orphaned key). Drained items are gone in
// minutes; this only bounds the worst case. Re-applied on every push.
const RESCREEN_QUEUE_TTL_SECONDS = 60 * 60 * 6; // 6h
// Max times an item is re-screened before it is dropped (OpenAI persistently down).
const RESCREEN_MAX_ATTEMPTS = 5;
// Drop the consequence-source label distinct from inline 'External' so a deferred
// block is traceable in ClickHouse / UserRestriction triggers while remaining an
// external-category block (semantics identical to inline external).
const RESCREEN_SOURCE = 'External-Deferred';

export interface PromptRescreenPayload {
  prompt: string;
  negativePrompt?: string;
  userId: number;
  isModerator?: boolean;
  remixOfId?: number;
  imageId?: number;
  attempt: number;
}

/**
 * Best-effort enqueue of a prompt whose inline external moderation was skipped
 * (the OpenAI call failed/timed-out). FIRE-AND-FORGET: never throws, never blocks
 * the caller — the generation hot path must be unaffected. Caps the queue length so
 * it can never grow unbounded.
 */
export function enqueuePromptRescreen(payload: PromptRescreenPayload): void {
  // Increment the metric eagerly (synchronous, cannot throw meaningfully) so the
  // skip is observable even if the async push below fails.
  try {
    externalModerationOutcomeCounter.inc({ outcome: 'skipped' });
  } catch {
    // metrics are best-effort
  }
  // Fire-and-forget: do not await, swallow all errors. A rejected promise here is
  // explicitly caught so it can never become an unhandledRejection.
  void (async () => {
    try {
      await sysRedis.rPush(RESCREEN_QUEUE_KEY, JSON.stringify(payload));
      await sysRedis.lTrim(RESCREEN_QUEUE_KEY, 0, RESCREEN_QUEUE_MAX - 1);
      await sysRedis.expire(RESCREEN_QUEUE_KEY, RESCREEN_QUEUE_TTL_SECONDS);
    } catch (error) {
      logToAxiom({
        name: 'prompt-rescreen-enqueue-error',
        type: 'error',
        message: (error as Error)?.message ?? 'unknown',
      });
    }
  })();
}

/**
 * Drain up to `batchSize` skipped-prompt items from the queue and re-screen each one
 * against the external moderation service. Applies the SAME consequence as the inline
 * path on a flag (addBlockedPrompt → reportProhibitedRequest); re-enqueues (up to the
 * attempt cap) on a transient re-screen failure; drops + logs at the cap.
 *
 * NEVER throws out of the whole function — a single bad item can't abort the batch.
 * Returns a summary suitable for the job's return value.
 */
export async function processPromptRescreenQueue(
  batchSize = 500
): Promise<{ processed: number; flagged: number; clean: number; requeued: number; dropped: number }> {
  const summary = { processed: 0, flagged: 0, clean: 0, requeued: 0, dropped: 0 };

  let raw: string[] | null = null;
  try {
    // LPOP COUNT from the head — with rPush enqueue this is FIFO (oldest first).
    raw = await sysRedis.lPopCount(RESCREEN_QUEUE_KEY, batchSize);
  } catch (error) {
    logToAxiom({
      name: 'prompt-rescreen-pop-error',
      type: 'error',
      message: (error as Error)?.message ?? 'unknown',
    });
    return summary;
  }

  if (!raw || raw.length === 0) return summary;

  for (const item of raw) {
    summary.processed++;

    let payload: PromptRescreenPayload;
    try {
      payload = JSON.parse(item) as PromptRescreenPayload;
    } catch {
      // Unparseable entry — drop it (cannot re-enqueue something we can't read).
      summary.dropped++;
      try {
        externalModerationOutcomeCounter.inc({ outcome: 'rescreen_dropped' });
      } catch {}
      continue;
    }

    const { prompt, negativePrompt, userId, isModerator, remixOfId, imageId, attempt } = payload;

    // Defensive: a malformed payload with no prompt/userId can't be screened.
    if (!prompt || typeof userId !== 'number') {
      summary.dropped++;
      try {
        externalModerationOutcomeCounter.inc({ outcome: 'rescreen_dropped' });
      } catch {}
      continue;
    }

    try {
      const { flagged, categories } = await extModeration.moderatePrompt(prompt);

      // Match the inline decision EXACTLY: inline blocks on `if (flagged)`. In the
      // prod config (EXTERNAL_MODERATION_CATEGORIES set) `flagged === categories.length>0`,
      // so this also covers the category path — but keying off `flagged` alone avoids a
      // config-coupled divergence where the deferred path could over-block.
      if (flagged) {
        // Count the screen result FIRST — the screen succeeded and DID flag.
        summary.flagged++;
        externalModerationOutcomeCounter.inc({ outcome: 'rescreen_flagged' });

        // Apply the consequence BEST-EFFORT — log on failure, do NOT re-enqueue. The
        // screen already determined this prompt is flagged; re-running it would call
        // addBlockedPrompt AGAIN and double-count toward the auto-mute threshold (could
        // wrongly mute a user on a transient Redis blip). A consequence write that fails
        // here is dropped: the generation already happened and the local regex audit +
        // Hive image-CSAM layers still apply. Only a re-SCREEN failure (OpenAI still
        // down, the catch below) is re-enqueued — that path hasn't counted anything yet.
        try {
          const blockedEntry: BlockedPromptEntry = {
            prompt: prompt ?? '',
            negativePrompt: negativePrompt ?? '',
            source: RESCREEN_SOURCE,
            category: 'external' as PromptTriggerCategory,
            matchedWord: categories?.[0],
            imageId: imageId ?? null,
            remixOfId: remixOfId ?? null,
            time: new Date().toISOString(),
          };

          const count = await addBlockedPrompt(userId, blockedEntry);

          // No `track` — the job has no request/tracker context. reportProhibitedRequest
          // tolerates a missing track (ClickHouse audit-track is skipped; the mute
          // escalation still runs off the Redis count).
          await reportProhibitedRequest({
            prompt,
            negativePrompt,
            userId,
            isModerator,
            source: RESCREEN_SOURCE,
            count,
            remixOfId,
          });
        } catch (consequenceError) {
          logToAxiom({
            name: 'prompt-rescreen-consequence-error',
            type: 'error',
            message: (consequenceError as Error)?.message ?? 'unknown',
            details: { userId },
          });
        }
      } else {
        summary.clean++;
        externalModerationOutcomeCounter.inc({ outcome: 'rescreen_clean' });
      }
    } catch (screenError) {
      // moderatePrompt threw again — OpenAI still unavailable. Re-enqueue: nothing has
      // been counted for this item yet, so a retry can't over-count.
      await requeueOrDrop(payload, summary, screenError);
    }
  }

  return summary;
}

/**
 * Re-enqueue an item with attempt+1 if under the cap, else drop it (+log). Never
 * throws — used inside the per-item loop above.
 */
async function requeueOrDrop(
  payload: PromptRescreenPayload,
  summary: { requeued: number; dropped: number },
  error: unknown
): Promise<void> {
  const nextAttempt = (payload.attempt ?? 0) + 1;
  if (nextAttempt < RESCREEN_MAX_ATTEMPTS) {
    try {
      await sysRedis.rPush(
        RESCREEN_QUEUE_KEY,
        JSON.stringify({ ...payload, attempt: nextAttempt })
      );
      await sysRedis.lTrim(RESCREEN_QUEUE_KEY, 0, RESCREEN_QUEUE_MAX - 1);
      await sysRedis.expire(RESCREEN_QUEUE_KEY, RESCREEN_QUEUE_TTL_SECONDS);
      summary.requeued++;
      externalModerationOutcomeCounter.inc({ outcome: 'rescreen_requeued' });
    } catch (requeueError) {
      // Even the re-enqueue failed — count it as dropped so the metric balances.
      summary.dropped++;
      try {
        externalModerationOutcomeCounter.inc({ outcome: 'rescreen_dropped' });
      } catch {}
      logToAxiom({
        name: 'prompt-rescreen-requeue-error',
        type: 'error',
        message: (requeueError as Error)?.message ?? 'unknown',
        details: { userId: payload.userId },
      });
    }
  } else {
    summary.dropped++;
    try {
      externalModerationOutcomeCounter.inc({ outcome: 'rescreen_dropped' });
    } catch {}
    logToAxiom({
      name: 'prompt-rescreen-dropped',
      type: 'warning',
      message: `dropped after ${nextAttempt} attempts: ${(error as Error)?.message ?? 'unknown'}`,
      details: { userId: payload.userId, attempts: nextAttempt },
    });
  }
}

export interface AuditPromptOptions {
  prompt: string;
  negativePrompt?: string;
  userId: number;
  isGreen: boolean; // true if on civitai.green (SFW-only domain)
  isModerator?: boolean;
  track?: any; // Tracker
  imageId?: number; // Source image ID when triggered during a remix
  remixOfId?: number; // The original image being remixed
}

/**
 * Centralized prompt auditing function that handles both regex and external moderation checks.
 *
 * @param options - Audit options including prompt, userId, and isGreen flag
 * @throws {TRPCError} If the prompt is flagged for inappropriate content
 *
 * Behavior:
 * - If isGreen is true (civitai.green), uses stricter rules (profanity checking enabled)
 * - If isGreen is false (civitai.com/civitai.red), uses standard NSFW blocking rules
 * - Tracks blocked attempts and escalates warnings based on user's violation count
 */
export async function auditPromptServer(options: AuditPromptOptions): Promise<void> {
  const { prompt, negativePrompt, userId, isGreen, isModerator, track, imageId, remixOfId } =
    options;

  // Skip auditing if prompt is empty (will be caught by validation elsewhere)
  if (!prompt || !prompt.trim()) {
    return;
  }

  try {
    // If isGreen is true (civitai.green), run profanity checks for SFW content
    // If isGreen is false (civitai.com/red), run standard NSFW blocking
    const checkProfanity = isGreen;

    // NOTE: Allowlist runtime filtering is disabled for now. The allowlist management
    // endpoints remain active so moderators can curate entries. To re-enable, uncomment
    // the allowlist fetch below and use filterAllowlistedTriggers() on each trigger set.
    // const allowlist = await getCachedPromptAllowlist();
    const allowlist = new Set<string>();

    // Run regex-based audit (enriched to capture structured trigger data)
    const { triggers, success } = auditPromptEnriched(prompt, negativePrompt, checkProfanity);

    if (!success) {
      // Filter out allowlisted triggers before counting toward mute
      const remainingTriggers = filterAllowlistedTriggers(triggers, allowlist);
      if (remainingTriggers.length > 0) {
        throw {
          blockedFor: remainingTriggers.map((t) => t.message),
          triggers: remainingTriggers,
          type: 'regex',
        };
      }
    }

    // Run external moderation service
    const { flagged, categories } = await extModeration.moderatePrompt(prompt).catch((error) => {
      logToAxiom({ name: 'external-moderation-error', type: 'error', message: error.message });
      // The inline external CSAM pre-screen was skipped (OpenAI slow/down). Enqueue the
      // prompt for deferred re-screen so the consequence is recovered when OpenAI is
      // healthy again. Fire-and-forget — never throws, never blocks; fail-soft preserved.
      enqueuePromptRescreen({
        prompt,
        negativePrompt,
        userId,
        isModerator,
        remixOfId,
        imageId,
        attempt: 0,
      });
      return { flagged: false, categories: [] as string[] };
    });

    if (flagged) {
      const externalTriggers: PromptTrigger[] = categories.map((cat) => ({
        category: 'external' as PromptTriggerCategory,
        message: cat,
        matchedWord: cat,
      }));
      // Filter out allowlisted external triggers
      const remainingTriggers = filterAllowlistedTriggers(externalTriggers, allowlist);
      if (remainingTriggers.length > 0) {
        throw {
          blockedFor: remainingTriggers.map((t) => t.message),
          triggers: remainingTriggers,
          type: 'external',
        };
      }
    }
  } catch (e) {
    const error = e as { blockedFor: string[]; triggers: PromptTrigger[]; type: string };

    // Build error message based on domain
    let message: string;

    if (isGreen) {
      // SFW-only domain (civitai.com) - stricter message
      message = `Your prompt was flagged: ${error.blockedFor.join(
        ', '
      )}.\n\nCivitai.com is intended for SFW content only. For NSFW content generation, please visit civitai.red where you have more freedom to generate mature content.`;
    } else {
      const source = error.type === 'external' ? 'External' : 'Regex';

      // Create blocked prompt entry
      const blockedEntry: BlockedPromptEntry = {
        prompt: prompt ?? '',
        negativePrompt: negativePrompt ?? '',
        source,
        category: error.triggers[0]?.category,
        matchedWord: error.triggers[0]?.matchedWord,
        imageId: imageId ?? null,
        remixOfId: remixOfId ?? null,
        time: new Date().toISOString(),
      };

      // Add to blocked prompts store and get count
      const count = await addBlockedPrompt(userId, blockedEntry);

      // Report to ClickHouse for audit logging and handle auto-mute
      await reportProhibitedRequest({
        prompt,
        negativePrompt,
        userId,
        isModerator,
        track,
        source,
        count,
        remixOfId,
      });

      // civitai.com/civitai.red - standard escalating warnings
      message = `Your prompt was flagged: ${error.blockedFor.join(', ')}`;

      if (count > constants.imageGeneration.requestBlocking.muted) {
        message += '. Your account has been muted.';
      } else if (count > constants.imageGeneration.requestBlocking.notified) {
        message +=
          '. Your account has been sent for review. If you continue to attempt blocked prompts, your generation permissions will be revoked.';
      } else if (count > constants.imageGeneration.requestBlocking.warned) {
        message +=
          '. If you continue to attempt blocked prompts, your account will be sent for review.';
      }
    }

    throw throwBadRequestError(message);
  }
}

/**
 * Report a prohibited request and potentially mute the user.
 * Tracks the request in ClickHouse (audit log) and auto-mutes based on the Redis count.
 */
async function reportProhibitedRequest(options: {
  prompt: string;
  negativePrompt?: string;
  userId: number;
  isModerator?: boolean;
  track?: any;
  source: string;
  count: number;
  remixOfId?: number;
}) {
  const { prompt, negativePrompt, userId, isModerator, track, source, count, remixOfId } = options;

  // Track the prohibited request in ClickHouse (audit log only)
  if (track) {
    try {
      await track.prohibitedRequest({
        prompt: prompt ?? '{error capturing prompt}',
        negativePrompt: negativePrompt ?? '{error capturing negativePrompt}',
        source,
        remixOfId,
      });
    } catch {
      // Continue with muting even if tracking fails
    }
  }

  // Skip muting for moderators
  if (isModerator) return;

  // Auto-mute when count exceeds the muted threshold
  if (count > constants.imageGeneration.requestBlocking.muted) {
    try {
      // Retrieve all blocked prompts from Redis for the UserRestriction record
      const allBlockedPrompts = await getBlockedPrompts(userId);

      // Create a UserRestriction record with ALL trigger data for moderator review
      await dbWrite.userRestriction.create({
        data: {
          userId,
          type: 'generation',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          triggers: allBlockedPrompts as any,
        },
      });

      // Only gate the user via `muted`. `mutedAt` is reserved for moderator
      // confirmation (uphold) — setting it here would make a Pending restriction
      // display as "Upheld" and trip the confirm-mutes cron.
      await updateUserById({
        id: userId,
        data: { muted: true },
        updateSource: 'promptAuditing:autoMute',
      });

      await refreshSession(userId);

      // Clear the blocked prompts from Redis now that they're stored in the DB
      await clearBlockedPromptsAfterMute(userId);

      // Notify the user about the restriction
      await createNotification({
        type: 'generation-muted',
        key: `generation-muted:${userId}:${Date.now()}`,
        category: NotificationCategory.System,
        userId,
        details: {},
      }).catch();
    } catch (banError) {
      logToAxiom({
        name: 'user-ban-creation-error',
        type: 'error',
        message: (banError as Error).message,
        details: { userId },
      });
    }

    if (track) {
      await track.userActivity({
        type: 'Muted',
        targetUserId: userId,
      });
    }
  }
}
