import { chunk } from 'lodash-es';
import { createJob } from './job';
import { createLogger } from '~/utils/logging';
import { logToAxiom } from '~/server/logging/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { crucibleEloRedis } from '~/server/redis/crucible-elo.redis';

const BATCH_SIZE = 50;

const log = createLogger('sync-crucible-scores', 'blue');

const logJob = (data: MixedObject) => {
  logToAxiom({ name: 'sync-crucible-scores', type: 'error', ...data }, 'webhooks').catch();
};

/**
 * Sync crucible scores from Redis to PostgreSQL
 *
 * This job runs every 5 minutes to:
 * 1. Query active crucibles
 * 2. Fetch ELO scores and vote counts from Redis
 * 3. Update CrucibleEntry records in PostgreSQL
 *
 * This provides data loss protection in case Redis restarts,
 * ensuring competition progress is preserved in the database.
 */
export const syncCrucibleScoresJob = createJob(
  'sync-crucible-scores',
  '*/5 * * * *', // Run every 5 minutes
  async () => {
    log('Starting sync-crucible-scores job');

    // Get all active crucibles
    const activeCrucibles = await dbRead.crucible.findMany({
      where: {
        status: CrucibleStatus.Active,
      },
      select: {
        id: true,
        name: true,
      },
    });

    if (activeCrucibles.length === 0) {
      log('No active crucibles to sync');
      return { synced: 0, crucibles: [] };
    }

    log(`Found ${activeCrucibles.length} active crucibles to sync`);

    const results: {
      crucibleId: number;
      entriesSynced: number;
    }[] = [];

    // Process each crucible
    for (const crucible of activeCrucibles) {
      try {
        log(`Syncing crucible ${crucible.id} (${crucible.name})...`);

        // Fetch all ELO scores and vote counts from Redis for this crucible
        const [eloScores, voteCounts] = await Promise.all([
          crucibleEloRedis.getAllElos(crucible.id),
          crucibleEloRedis.getAllVoteCounts(crucible.id),
        ]);

        const entryIds = Object.keys(eloScores).map(Number);

        if (entryIds.length === 0) {
          log(`Crucible ${crucible.id}: No entries in Redis, skipping`);
          continue;
        }

        log(
          `Crucible ${crucible.id}: Found ${entryIds.length} entries in Redis, syncing to database...`
        );

        // Process updates in batches to avoid database lock timeouts on large crucibles
        const batches = chunk(entryIds, BATCH_SIZE);
        let successCount = 0;
        let errorCount = 0;

        for (const batch of batches) {
          try {
            // Process each batch with Promise.all for concurrent updates within the batch
            await Promise.all(
              batch.map(async (entryId) => {
                const score = eloScores[entryId];
                const voteCount = voteCounts[entryId] || 0;

                await dbWrite.crucibleEntry.updateMany({
                  where: {
                    id: entryId,
                    crucibleId: crucible.id,
                  },
                  data: {
                    score,
                    voteCount,
                  },
                });
              })
            );
            successCount += batch.length;
          } catch (batchError) {
            // Log error for this batch but continue with other batches
            const batchErrorMessage =
              batchError instanceof Error ? batchError.message : String(batchError);
            log(
              `Crucible ${crucible.id}: Batch error (${batch.length} entries): ${batchErrorMessage}`
            );
            errorCount += batch.length;

            logJob({
              message: 'Batch sync error',
              data: {
                crucibleId: crucible.id,
                batchSize: batch.length,
                error: batchErrorMessage,
              },
            });
          }
        }

        if (errorCount > 0) {
          log(
            `Crucible ${crucible.id}: Synced ${successCount} entries, ${errorCount} failed`
          );
        } else {
          log(`Crucible ${crucible.id}: Successfully synced ${successCount} entries`);
        }

        results.push({
          crucibleId: crucible.id,
          entriesSynced: successCount,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Failed to sync crucible ${crucible.id}: ${errorMessage}`);

        logJob({
          message: 'Failed to sync crucible scores',
          data: {
            crucibleId: crucible.id,
            error: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
          },
        });

        // Continue with other crucibles even if one fails
      }
    }

    const totalSynced = results.reduce((sum, r) => sum + r.entriesSynced, 0);

    log(
      `Sync-crucible-scores job complete: ${results.length} crucibles synced, ${totalSynced} total entries updated`
    );

    return {
      synced: results.length,
      totalEntries: totalSynced,
      crucibles: results,
    };
  },
  {
    // Lock for 5 minutes to prevent concurrent runs
    lockExpiration: 5 * 60,
  }
);

// Export as array for consistent pattern with other job files
export const crucibleSyncJobs = [syncCrucibleScoresJob];
