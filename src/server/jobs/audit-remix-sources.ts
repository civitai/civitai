import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { extModeration } from '~/server/integrations/moderation';
import { auditPromptEnriched } from '~/utils/metadata/audit';
import { imageMetaOutput } from '~/server/schema/image.schema';
import { bustCachesForPosts } from '~/server/services/post.service';
import { createJob } from './job';

const DEDUP_TTL = 60 * 60 * 24; // 24 hours — don't re-audit the same source image within a day
const LOOKBACK_HOURS = 2; // Overlapping window for safety (job runs hourly)

function getRemixAuditCheckedKey(imageId: number) {
  return `${REDIS_SYS_KEYS.GENERATION.REMIX_AUDIT_CHECKED}:${imageId}` as const;
}

/**
 * Periodic job that checks source images from blocked remix attempts.
 *
 * When a user's remix prompt is blocked, we record the remixOfId in ClickHouse.
 * This job queries for those source image IDs, looks up the original image's prompt,
 * and runs it through prompt auditing. If the source image's prompt is also
 * problematic, the image is flagged for moderator review in the "Remix Source" queue.
 */
export const auditRemixSourcesJob = createJob(
  'audit-remix-sources',
  '0 * * * *', // Every hour
  async (jobContext) => {
    const { clickhouse } = await import('~/server/clickhouse/client');
    if (!clickhouse) return;

    // 1. Query ClickHouse for distinct remixOfId values from recent prohibited requests
    const rows = await clickhouse.$query<{ remixOfId: number }>`
      SELECT DISTINCT remixOfId
      FROM prohibitedRequests
      WHERE remixOfId IS NOT NULL
        AND time > subtractHours(now(), ${LOOKBACK_HOURS})
    `;

    if (rows.length === 0) return;

    let audited = 0;
    let flagged = 0;

    for (const row of rows) {
      jobContext.checkIfCanceled();

      const imageId = row.remixOfId;

      // 2. Deduplicate — skip if we've already checked this image recently
      const checkedKey = getRemixAuditCheckedKey(imageId);
      const alreadyChecked = await sysRedis.get(checkedKey);
      if (alreadyChecked) continue;

      // Mark as checked immediately to avoid racing with parallel runs
      await sysRedis.set(checkedKey, '1');
      await sysRedis.expire(checkedKey, DEDUP_TTL);

      try {
        // 3. Look up the source image's prompt
        const image = await dbRead.image.findUnique({
          where: { id: imageId },
          select: {
            id: true,
            meta: true,
            metadata: true,
            userId: true,
            needsReview: true,
            ingestion: true,
          },
        });

        if (!image || !image.meta) continue;

        // Skip if already in a review queue, blocked, or previously reviewed by a mod
        if (image.needsReview || image.ingestion === 'Blocked') continue;
        const metadata = image.metadata as Record<string, unknown> | null;
        if (metadata?.remixSourceReviewed) continue;

        const parsedMeta = imageMetaOutput.safeParse(image.meta);
        if (!parsedMeta.success) continue;

        const prompt = parsedMeta.data.prompt;
        if (!prompt?.trim()) continue;

        const negativePrompt = parsedMeta.data.negativePrompt;
        audited++;

        // 4. Run prompt auditing (regex + external moderation)
        let isProblematic = false;

        // Regex-based audit
        const { success } = auditPromptEnriched(prompt, negativePrompt, false);
        if (!success) {
          isProblematic = true;
        }

        // External moderation (only if regex passed)
        if (!isProblematic) {
          try {
            const { flagged: extFlagged } = await extModeration.moderatePrompt(prompt);
            if (extFlagged) isProblematic = true;
          } catch {
            // If external moderation fails, skip — don't flag based on unavailability
          }
        }

        // 5. Flag for moderator review if problematic
        if (isProblematic) {
          const updated = await dbWrite.image.update({
            where: { id: imageId },
            data: { needsReview: 'remixSource' },
            select: { postId: true },
          });
          // Flagged images need to disappear from the model-version showcase.
          if (updated.postId) await bustCachesForPosts(updated.postId);
          flagged++;
        }
      } catch (error) {
        logToAxiom({
          name: 'audit-remix-sources',
          type: 'error',
          message: (error as Error).message,
          details: { imageId },
        });
      }
    }

    return { audited, flagged, candidates: rows.length };
  },
  { shouldWait: false, lockExpiration: 10 * 60 }
);
