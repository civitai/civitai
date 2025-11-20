import { TRPCError } from '@trpc/server';
import { constants } from '~/server/common/constants';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';
import { updateUserById } from '~/server/services/user.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { createLimiter } from '~/server/utils/rate-limiting';
import { auditPrompt } from '~/utils/metadata/audit';
import { refreshSession } from '~/server/auth/session-invalidation';

const blockedPromptLimiter = createLimiter({
  counterKey: REDIS_KEYS.GENERATION.COUNT,
  limitKey: REDIS_SYS_KEYS.GENERATION.LIMITS,
  fetchCount: async (userKey) => {
    const { clickhouse } = await import('~/server/clickhouse/client');
    if (!clickhouse) return 0;
    const data = await clickhouse.$query<{ count: number }>`
      SELECT
        COUNT(*) as count
      FROM prohibitedRequests
      WHERE time > subtractHours(now(), 24) AND userId = ${userKey}
    `;
    const count = data[0]?.count ?? 0;
    return count;
  },
});

export interface AuditPromptOptions {
  prompt: string;
  negativePrompt?: string;
  userId: number;
  isGreen: boolean; // true if on civitai.green (SFW-only domain)
  isModerator?: boolean;
  track?: any; // Tracker
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
  const { prompt, negativePrompt, userId, isGreen, isModerator, track } = options;

  // Skip auditing if prompt is empty (will be caught by validation elsewhere)
  if (!prompt || !prompt.trim()) {
    return;
  }

  try {
    // If isGreen is true (civitai.green), run profanity checks for SFW content
    // If isGreen is false (civitai.com/red), run standard NSFW blocking
    const checkProfanity = isGreen;

    // Run regex-based audit first
    const { blockedFor, success } = auditPrompt(prompt, negativePrompt, checkProfanity);

    if (!success) throw { blockedFor, type: 'regex' };

    // Run external moderation service
    const { flagged, categories } = await extModeration.moderatePrompt(prompt).catch((error) => {
      logToAxiom({ name: 'external-moderation-error', type: 'error', message: error.message });
      return { flagged: false, categories: [] as string[] };
    });

    if (flagged) throw { blockedFor: categories, type: 'external' };
  } catch (e) {
    const error = e as { blockedFor: string[]; type: string };

    // Build error message based on domain
    let message: string;

    if (isGreen) {
      // civitai.green - stricter message for SFW-only domain
      message = `Your prompt was flagged: ${error.blockedFor.join(
        ', '
      )}.\n\nCivitai.green is intended for SFW content only. For NSFW content generation, please visit civitai.com where you have more freedom to generate mature content.`;
    } else {
      await reportProhibitedRequest({
        prompt,
        negativePrompt,
        userId,
        isModerator,
        track,
        source: error.type === 'external' ? 'External' : 'Regex',
      });

      // Track the violation count
      const count = await blockedPromptLimiter.increment(userId.toString());

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
 * Report a prohibited request and potentially mute the user
 * This function tracks the request and checks if the user should be muted
 */
async function reportProhibitedRequest(options: {
  prompt: string;
  negativePrompt?: string;
  userId: number;
  isModerator?: boolean;
  track?: any;
  source: string;
}) {
  const { prompt, negativePrompt, userId, isModerator, track, source } = options;

  // Track the prohibited request
  if (track) {
    await track.prohibitedRequest({
      prompt: prompt ?? '{error capturing prompt}',
      negativePrompt: negativePrompt ?? '{error capturing negativePrompt}',
      source,
    });
  }

  // Skip muting for moderators
  if (isModerator) return;

  // Check if user should be muted
  const { clickhouse } = await import('~/server/clickhouse/client');
  if (!clickhouse) return;

  try {
    const count =
      (
        await clickhouse.$query<{ count: number }>`
      SELECT
        COUNT(*) as count
      FROM prohibitedRequests
      WHERE userId = ${userId} AND time > subtractHours(now(), 24);
    `
      )[0]?.count ?? 0;

    const limit =
      constants.imageGeneration.requestBlocking.muted -
      constants.imageGeneration.requestBlocking.notified;

    if (count >= limit) {
      await updateUserById({
        id: userId,
        data: { muted: true },
        updateSource: 'promptAuditing:autoMute',
      });
      await refreshSession(userId);

      if (track) {
        await track.userActivity({
          type: 'Muted',
          targetUserId: userId,
        });
      }
    }
  } catch (error) {
    throw new TRPCError({
      message: 'Error checking prohibited request count',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
}
