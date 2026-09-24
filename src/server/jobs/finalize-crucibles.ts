import { createJob } from './job';
import { createLogger } from '~/utils/logging';
import {
  activateScheduledCrucibles,
  finalizeCrucible,
  getCruciblesForFinalization,
} from '~/server/services/crucible.service';
import { logToAxiom } from '~/server/logging/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';

const log = createLogger('finalize-crucibles', 'yellow');

const logJob = (data: MixedObject) => {
  logToAxiom({ name: 'finalize-crucibles', type: 'error', ...data }, 'webhooks').catch();
};

/**
 * Finalize crucibles background job
 *
 * This job runs every minute to:
 * 1. Activate scheduled crucibles whose startAt has passed
 * 2. Query active crucibles where endAt < now
 * 3. Call finalizeCrucible() for each
 * 4. Log results
 *
 * Redis locking is handled by the job runner infrastructure
 */
export const finalizeCruciblesJob = createJob(
  'finalize-crucibles',
  '* * * * *', // Run every minute
  async () => {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CRUCIBLE_JOBS_ENABLED))) return { finalized: 0 };

    log('Starting finalize-crucibles job');

    // Before finalization: finalization only picks up Active crucibles, so a scheduled one whose
    // whole window passed while the job was off would otherwise sit in Pending forever.
    const activated = await activateScheduledCrucibles();
    if (activated > 0) log(`Activated ${activated} scheduled crucibles`);

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
