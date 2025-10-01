// Environment variables are loaded via ~/env/server when we import from ~/server/*
// Make sure NODE_ENV is set before running (use: npx cross-env NODE_ENV=development npx tsx ...)

import pLimit from 'p-limit';
import { pgDbRead } from '~/server/db/pgDb';
import { clickhouse } from '~/server/clickhouse/client';
import { createLogger } from '~/utils/logging';
import type { MigrationPackage, MigrationParams, EntityMetricEvent, BatchRange } from './types';
import { ProgressTracker, batchInsertClickhouse, CUTOFF_DATE, retryable } from './utils';
import * as migrationPackages from './metric-packages';

const logger = createLogger('metric-backfill-runner');

// Wrapper to provide simplified query interface
function createQueryContext() {
  return {
    pg: {
      query: async <T = any>(sql: string, params?: any[]) => {
        return pgDbRead.query<T>(sql, params);
      },
    },
    ch: {
      query: async <T = any>(sql: string) => {
        const result = await clickhouse.query({ query: sql });
        return result.json<T>();
      },
    },
  };
}

export async function runMigrations(
  packages: Record<string, MigrationPackage>,
  params: MigrationParams = {}
) {
  const progressBar = new ProgressTracker();
  const queryContext = createQueryContext();

  // Filter packages if specified
  const packageEntries = Object.entries(packages);
  const packagesToRun = params.packages
    ? packageEntries.filter(([name]) => params.packages!.includes(name))
    : packageEntries;

  logger.info(`Running ${packagesToRun.length} migration packages`);
  logger.info(`Cutoff date: ${CUTOFF_DATE}`);
  logger.info(`Concurrency: ${params.concurrency ?? 1}`);
  logger.info(`Insert batch size: ${params.insertBatchSize ?? 500}`);
  if (params.dryRun) {
    logger.info(`DRY RUN MODE: No data will be inserted`);
  }

  // Load saved progress if auto-resume is enabled
  const savedProgress = params.autoResume ? await progressBar.loadProgress() : {};

  for (const [name, pkg] of packagesToRun) {
    progressBar.start(name);

    const queryBatchSize = pkg.queryBatchSize ?? 1000;
    let totalMetrics = 0;

    try {
      // Get the full range for this migration
      const { start: rangeStart, end: rangeEnd } = await retryable(() =>
        pkg.range(queryContext)
      );

      if (rangeStart === 0 && rangeEnd === 0) {
        logger.info(`${name}: No data to process`);
        progressBar.complete(name, 0);
        continue;
      }

      const totalBatches = Math.ceil((rangeEnd - rangeStart) / queryBatchSize);
      progressBar.setTotal(name, totalBatches);

      // Process in batches with controlled concurrency
      const batches: BatchRange[] = [];
      for (let start = rangeStart; start <= rangeEnd; start += queryBatchSize) {
        batches.push({
          start,
          end: Math.min(start + queryBatchSize - 1, rangeEnd),
        });
      }

      // Skip to startFrom batch if specified, or use saved progress
      const startIndex = params.startFrom ?? savedProgress[name] ?? 0;
      if (startIndex > 0) {
        logger.info(`${name}: Resuming from batch ${startIndex}`);
      }
      let batchesToProcess = batches.slice(startIndex);

      // Limit batches if specified (for testing)
      if (params.limitBatches) {
        batchesToProcess = batchesToProcess.slice(0, params.limitBatches);
        logger.info(`${name}: Limiting to ${params.limitBatches} batches for testing`);
      }

      // Use p-limit for concurrency control
      const limit = pLimit(params.concurrency ?? 1);

      await Promise.all(
        batchesToProcess.map((batchRange, index) =>
          limit(async () => {
            const actualIndex = startIndex + index;

            try {
              // Execute query for this batch with retry
              const rows = await retryable(() => pkg.query(queryContext, batchRange));

              // Process rows and collect metrics
              const metrics: EntityMetricEvent[] = [];
              await pkg.processor({
                ...queryContext,
                rows,
                addMetrics: (...m) => {
                  metrics.push(...m.flat());
                },
              });

              // Batch insert into ClickHouse with retry
              if (metrics.length > 0) {
                await retryable(() =>
                  batchInsertClickhouse(
                    metrics,
                    params.insertBatchSize,
                    params.dryRun ?? false
                  )
                );
              }

              totalMetrics += metrics.length;
              await progressBar.updateBatch(name, actualIndex + 1, metrics.length);
            } catch (error) {
              logger.error(`${name}: Error processing batch ${actualIndex + 1}`, error);
              throw error;
            }
          })
        )
      );

      progressBar.complete(name, totalMetrics);
    } catch (error) {
      progressBar.error(name, error);
      throw error;
    }
  }

  logger.info('All migrations completed successfully');

  // Clear progress file on successful completion
  if (!params.dryRun) {
    await progressBar.clearProgress();
  }
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);
  const params: MigrationParams = {
    concurrency: 10,
    insertBatchSize: 500,
  };

  // Parse CLI arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--concurrency' && args[i + 1]) {
      params.concurrency = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--batch-size' && args[i + 1]) {
      params.insertBatchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--start-from' && args[i + 1]) {
      params.startFrom = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--packages' && args[i + 1]) {
      params.packages = args[i + 1].split(',');
      i++;
    } else if (arg === '--limit-batches' && args[i + 1]) {
      params.limitBatches = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--dry-run') {
      params.dryRun = true;
    } else if (arg === '--auto-resume') {
      params.autoResume = true;
    }
  }

  try {
    await runMigrations(migrationPackages, params);
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
