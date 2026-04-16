import { dbRead, dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { resolveEntityContentBulk } from '~/server/services/entity-moderation.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';
import { decreaseDate } from '~/utils/date-helpers';

const TEXT_MODERATION_RETRY_DELAY_MINUTES = 60; // 1 hour for terminal failures
const TEXT_MODERATION_PENDING_TIMEOUT_MINUTES = 30; // 30 min for stuck Pending rows
const TEXT_MODERATION_RETRY_LIMIT = 9;
const FETCH_LIMIT = 500; // max rows pulled per job tick
const SUBMIT_CONCURRENCY = 5; // parallel orchestrator submissions

export const retryFailedTextModeration = createJob(
  'retry-failed-text-moderation',
  '*/15 * * * *',
  async () => {
    const now = new Date();
    const retryBefore = decreaseDate(now, TEXT_MODERATION_RETRY_DELAY_MINUTES, 'minutes');
    const pendingTimeoutBefore = decreaseDate(
      now,
      TEXT_MODERATION_PENDING_TIMEOUT_MINUTES,
      'minutes'
    );

    const rows = await dbRead.entityModeration.findMany({
      where: {
        retryCount: { lt: TEXT_MODERATION_RETRY_LIMIT },
        OR: [
          {
            status: {
              in: [
                EntityModerationStatus.Failed,
                EntityModerationStatus.Expired,
                EntityModerationStatus.Canceled,
              ],
            },
            updatedAt: { lte: retryBefore },
          },
          {
            // Pending rows whose callback never arrived (stuck in flight)
            status: EntityModerationStatus.Pending,
            updatedAt: { lte: pendingTimeoutBefore },
          },
        ],
      },
      select: { id: true, entityType: true, entityId: true },
      orderBy: { updatedAt: 'asc' },
      take: FETCH_LIMIT,
    });

    if (!rows.length) return { processed: 0, retried: 0, missing: 0, errors: 0 };

    // Group by entityType so we can bulk-fetch content per type
    const byType = new Map<string, { id: number; entityId: number }[]>();
    for (const row of rows) {
      const list = byType.get(row.entityType) ?? [];
      list.push({ id: row.id, entityId: row.entityId });
      byType.set(row.entityType, list);
    }

    let retried = 0;
    let missing = 0;
    let errors = 0;
    const missingRowIds: number[] = [];

    for (const [entityType, items] of byType) {
      let contentMap: Map<number, string>;
      try {
        contentMap = await resolveEntityContentBulk({
          entityType,
          entityIds: items.map((x) => x.entityId),
        });
      } catch (error) {
        errors += items.length;
        await logToAxiom({
          name: 'retry-failed-text-moderation',
          type: 'error',
          message: `Bulk content resolve failed: ${(error as Error).message}`,
          entityType,
          count: items.length,
        });
        continue;
      }

      const submissions = items.map((item) => async () => {
        const content = contentMap.get(item.entityId);
        if (content == null) {
          missingRowIds.push(item.id);
          missing++;
          return;
        }

        try {
          const workflow = await submitTextModeration({
            entityType,
            entityId: item.entityId,
            content,
            labels: ['nsfw'],
            priority: 'low',
          });
          if (workflow?.id) retried++;
          else errors++;
        } catch (error) {
          errors++;
          await logToAxiom({
            name: 'retry-failed-text-moderation',
            type: 'error',
            message: (error as Error).message,
            entityType,
            entityId: item.entityId,
          });
        }
      });

      await limitConcurrency(submissions, SUBMIT_CONCURRENCY);
    }

    // Clean up rows whose underlying entity no longer exists
    if (missingRowIds.length) {
      await dbWrite.entityModeration.deleteMany({ where: { id: { in: missingRowIds } } });
    }

    return { processed: rows.length, retried, missing, errors };
  }
);
