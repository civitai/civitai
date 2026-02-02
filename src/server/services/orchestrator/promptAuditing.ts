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
  time: string;
}

const BLOCKED_PROMPTS_TTL = 60 * 60 * 24; // 24 hours
const RESET_MARKER = '__RESET__';

function getBlockedPromptsKey(userId: number) {
  return `${REDIS_SYS_KEYS.GENERATION.BLOCKED_PROMPTS}:${userId}` as const;
}

/** Seed the blocked prompts list from ClickHouse for today's violations */
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
    time: string;
  }>`
    SELECT prompt, negativePrompt, source, time
    FROM prohibitedRequests
    WHERE toDate(time) = today() AND userId = ${userId}
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

  // Check if list only contains reset marker - if so, remove it first
  const currentEntries = await sysRedis.lRange(key, 0, -1);
  if (currentEntries.length === 1 && currentEntries[0] === RESET_MARKER) {
    await sysRedis.del(key);
  }

  await sysRedis.lPush(key, JSON.stringify(entry));
  await sysRedis.expire(key, BLOCKED_PROMPTS_TTL);

  // Return count (lLen is faster than fetching all entries)
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

export interface AuditPromptOptions {
  prompt: string;
  negativePrompt?: string;
  userId: number;
  isGreen: boolean; // true if on civitai.green (SFW-only domain)
  isModerator?: boolean;
  track?: any; // Tracker
  imageId?: number; // Source image ID when triggered during a remix
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
  const { prompt, negativePrompt, userId, isGreen, isModerator, track, imageId } = options;

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
      // civitai.green - stricter message for SFW-only domain
      message = `Your prompt was flagged: ${error.blockedFor.join(
        ', '
      )}.\n\nCivitai.green is intended for SFW content only. For NSFW content generation, please visit civitai.com where you have more freedom to generate mature content.`;
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
}) {
  const { prompt, negativePrompt, userId, isModerator, track, source, count } = options;

  // Track the prohibited request in ClickHouse (audit log only)
  if (track) {
    try {
      await track.prohibitedRequest({
        prompt: prompt ?? '{error capturing prompt}',
        negativePrompt: negativePrompt ?? '{error capturing negativePrompt}',
        source,
      });
    } catch {
      // Continue with muting even if tracking fails
    }
  }

  // Skip muting for moderators
  if (isModerator) return;

  // Auto-mute when count exceeds the muted threshold
  if (count > constants.imageGeneration.requestBlocking.muted) {
    await updateUserById({
      id: userId,
      data: { muted: true },
      updateSource: 'promptAuditing:autoMute',
    });
    await refreshSession(userId);

    // Retrieve all blocked prompts from Redis for the UserRestriction record
    const allBlockedPrompts = await getBlockedPrompts(userId);

    // Create a UserRestriction record with ALL trigger data for moderator review
    try {
      await dbWrite.userRestriction.create({
        data: {
          userId,
          type: 'generation',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          triggers: allBlockedPrompts as any,
        },
      });

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
