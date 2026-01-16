import { createJob } from './job';
import { createLogger } from '~/utils/logging';
import { finalizeCrucible, getCruciblesForFinalization } from '~/server/services/crucible.service';
import { logToAxiom } from '~/server/logging/client';

const log = createLogger('finalize-crucibles', 'yellow');

const logJob = (data: MixedObject) => {
  logToAxiom({ name: 'finalize-crucibles', type: 'error', ...data }, 'webhooks').catch();
};

/**
 * Finalize crucibles background job
 *
 * This job runs every minute to:
 * 1. Query active crucibles where endAt < now
 * 2. Call finalizeCrucible() for each
 * 3. Log results
 *
 * Redis locking is handled by the job runner infrastructure
 */
export const finalizeCruciblesJob = createJob(
  'finalize-crucibles',
  '* * * * *', // Run every minute
  async () => {
    log('Starting finalize-crucibles job');

    // Get all crucibles that need finalization
    const crucibleIds = await getCruciblesForFinalization();

    if (crucibleIds.length === 0) {
      log('No crucibles to finalize');
      return { finalized: 0 };
    }

    log(`Found ${crucibleIds.length} crucibles to finalize: ${crucibleIds.join(', ')}`);

    const results: {
      success: number[];
      failed: { id: number; error: string }[];
    } = {
      success: [],
      failed: [],
    };

    // Process each crucible
    for (const crucibleId of crucibleIds) {
      try {
        log(`Finalizing crucible ${crucibleId}...`);
        const result = await finalizeCrucible(crucibleId);

        log(
          `Crucible ${crucibleId} finalized: ${result.finalEntries.length} entries, ${result.totalPrizesDistributed} Buzz in prizes distributed`
        );

        results.success.push(crucibleId);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Failed to finalize crucible ${crucibleId}: ${errorMessage}`);

        logJob({
          message: 'Failed to finalize crucible',
          data: {
            crucibleId,
            error: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
          },
        });

        results.failed.push({ id: crucibleId, error: errorMessage });
      }
    }

    log(
      `Finalize-crucibles job complete: ${results.success.length} succeeded, ${results.failed.length} failed`
    );

    return {
      finalized: results.success.length,
      failed: results.failed.length,
      successIds: results.success,
      failedIds: results.failed,
    };
  },
  {
    // Lock for 5 minutes (default) to prevent concurrent runs
    lockExpiration: 5 * 60,
  }
);

// Export as array for consistent pattern with other job files
export const crucibleJobs = [finalizeCruciblesJob];
