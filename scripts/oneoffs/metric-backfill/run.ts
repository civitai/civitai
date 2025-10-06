// Environment variables are loaded via ~/env/server when we import from ~/server/*
// Make sure NODE_ENV is set before running (use: npx cross-env NODE_ENV=development npx tsx ...)

import pLimit from 'p-limit';
import type { MigrationPackage, MigrationParams, EntityMetricEvent, BatchRange } from './types';
import { ProgressTracker, batchInsertClickhouse, CUTOFF_DATE, retryable, pgDb, clickhouse } from './utils';
import * as migrationPackages from './metric-packages';

// Wrapper to provide simplified query interface
function createQueryContext(dryRun: boolean) {
  return {
    pg: {
      query: async <T = any>(sql: string, params?: any[]) => {
        const { rows } = await pgDb.query<T[]>(sql, params);
        return rows;
      },
    },
    ch: {
      query: async <T = any>(sql: string) => {
        const result = await clickhouse.query({ query: sql, format: 'JSONEachRow' });
        return result.json<T>();
      },
    },
    dryRun,
  };
}

export async function runMigrations(
  packages: Record<string, MigrationPackage>,
  params: MigrationParams = {}
) {
  console.log('Initializing migration runner...');
  const progressBar = new ProgressTracker();

  console.log('Creating query context...');
  const queryContext = createQueryContext(params.dryRun ?? false);

  // Filter packages if specified
  console.log('Loading migration packages...');
  const packageEntries = Object.entries(packages);
  console.log(`Found ${packageEntries.length} total packages`);

  const packagesToRun = params.packages
    ? packageEntries.filter(([name]) => params.packages!.includes(name))
    : packageEntries;

  console.log(`Running ${packagesToRun.length} migration packages`);
  console.log(`Package names: ${packagesToRun.map(([name]) => name).join(', ')}`);
  console.log(`Cutoff date: ${CUTOFF_DATE}`);
  console.log(`Concurrency: ${params.concurrency ?? 1}`);
  console.log(`Insert batch size: ${params.insertBatchSize ?? 500}`);
  if (params.dryRun) {
    console.log(`DRY RUN MODE: No data will be inserted`);
  }
  if (params.limitBatches) {
    console.log(`LIMITING BATCHES: Will process max ${params.limitBatches} batches per package`);
  }

  // Load saved progress if auto-resume is enabled
  console.log('Checking for saved progress...');
  const savedProgress = params.autoResume ? await progressBar.loadProgress() : {};
  if (Object.keys(savedProgress).length > 0) {
    console.log(`Found saved progress: ${JSON.stringify(savedProgress)}`);
  }

  for (const [name, pkg] of packagesToRun) {
    console.log(`\n=== Starting package: ${name} ===`);
    progressBar.start(name);

    const queryBatchSize = pkg.queryBatchSize ?? 1000;
    console.log(`${name}: Query batch size: ${queryBatchSize}`);
    let totalMetrics = 0;

    try {
      // Get the full range for this migration
      console.log(`${name}: Fetching data range...`);
      const range = await retryable(() => pkg.range(queryContext));
      const rangeStart = Number(range.start);
      const rangeEnd = Number(range.end);
      console.log(`${name}: Range fetched - start: ${rangeStart}, end: ${rangeEnd}`);

      if (rangeStart === 0 && rangeEnd === 0) {
        console.log(`${name}: No data to process`);
        progressBar.complete(name, 0);
        continue;
      }

      const totalBatches = Math.ceil((rangeEnd - rangeStart) / queryBatchSize);
      progressBar.setTotal(name, totalBatches);

      // Skip to startFrom batch if specified, or use saved progress
      const startIndex = params.startFrom ?? savedProgress[name] ?? 0;
      if (startIndex > 0) {
        console.log(`${name}: Resuming from batch ${startIndex}`);
      }

      // Calculate total batches to process
      let batchCount = totalBatches - startIndex;
      if (params.limitBatches) {
        batchCount = Math.min(batchCount, params.limitBatches);
        console.log(`${name}: Limiting to ${params.limitBatches} batches for testing`);
      }

      console.log(`${name}: Processing ${batchCount} batches with concurrency ${params.concurrency ?? 1}`);

      // Use p-limit for concurrency control
      const limit = pLimit(params.concurrency ?? 1);

      // Buffer for accumulating metrics across batches before flushing to ClickHouse
      const FLUSH_THRESHOLD = 100000;
      let metricsBuffer: EntityMetricEvent[] = [];
      const activeFlushes = new Set<Promise<void>>();

      // Simple mutex to protect buffer access without promise chaining
      let bufferMutex: Promise<void> | null = null;
      const acquireBufferLock = async () => {
        while (bufferMutex) {
          await bufferMutex;
        }
        let releaseLock: () => void;
        bufferMutex = new Promise(resolve => { releaseLock = resolve; });
        return releaseLock!;
      };

      const flushBuffer = async (toFlush: EntityMetricEvent[]) => {
        if (params.dryRun) {
          console.log(`${name}: [DRY RUN] Would flush ${toFlush.length} metrics to ClickHouse`);
          return;
        }

        console.log(`${name}: Flushing ${toFlush.length} metrics to ClickHouse...`);
        const flushPromise = retryable(() =>
          clickhouse.insert({
            table: 'entityMetricEvents_testing',
            values: toFlush,
            format: 'JSONEachRow',
            clickhouse_settings: {
              async_insert: 1,
              wait_for_async_insert: 0,
            },
          })
        ).then(() => {
          activeFlushes.delete(flushPromise);
          console.log(`${name}: Flush complete (${toFlush.length} metrics)`);
        });

        activeFlushes.add(flushPromise);
      };

      // Process batches with controlled concurrency
      const processBatch = async (batchRange: BatchRange, actualIndex: number) => {
        try {
          // Execute query for this batch with retry
          console.log(`${name}: [Batch ${actualIndex + 1}] Querying range ${batchRange.start}-${batchRange.end}...`);
          const rows = await retryable(() => pkg.query(queryContext, batchRange));
          console.log(`${name}: [Batch ${actualIndex + 1}] Retrieved ${rows.length} rows`);

          // Process rows and collect metrics
          console.log(`${name}: [Batch ${actualIndex + 1}] Processing rows...`);
          const metrics: EntityMetricEvent[] = [];
          await pkg.processor({
            ...queryContext,
            rows,
            addMetrics: (...m) => {
              // Avoid stack overflow from spread operator with large arrays
              const flattened = m.flat();
              for (const metric of flattened) {
                metrics.push(metric);
              }
            },
          });
          console.log(`${name}: [Batch ${actualIndex + 1}] Generated ${metrics.length} metric events`);

          // Add to buffer and flush if threshold reached
          if (metrics.length > 0) {
            let toFlush: EntityMetricEvent[] | null = null;

            // Acquire lock, modify buffer, release lock
            const releaseLock = await acquireBufferLock();
            try {
              // Avoid stack overflow from spread operator with large arrays
              metricsBuffer = metricsBuffer.concat(metrics);
              console.log(`${name}: [Batch ${actualIndex + 1}] Buffer size: ${metricsBuffer.length}`);

              // Check if we need to flush
              if (metricsBuffer.length >= FLUSH_THRESHOLD) {
                toFlush = metricsBuffer;
                metricsBuffer = [];
              }
            } finally {
              releaseLock();
              bufferMutex = null;
            }

            // Flush happens outside the lock
            if (toFlush) {
              flushBuffer(toFlush);
            }
          }

          totalMetrics += metrics.length;
          await progressBar.updateBatch(name, actualIndex + 1, metrics.length);
        } catch (error) {
          console.error(`${name}: Error processing batch ${actualIndex + 1}`, error);
          throw error;
        }
      };

      // Use async generator to create batches on-demand
      async function* generateBatches() {
        let batchIndex = 0;
        for (let start = rangeStart + (startIndex * queryBatchSize);
             start <= rangeEnd && batchIndex < batchCount;
             start += queryBatchSize, batchIndex++) {
          // Use start + queryBatchSize - 1 to avoid overlaps between batches
          // Batch 1: [0, 999], Batch 2: [1000, 1999], etc.
          const end = Math.min(start + queryBatchSize - 1, rangeEnd);
          yield {
            batchRange: { start, end },
            actualIndex: startIndex + batchIndex,
          };
        }
      }

      // Process batches with controlled concurrency using async iteration
      const activePromises = new Set<Promise<void>>();

      for await (const { batchRange, actualIndex } of generateBatches()) {
        // Clean up completed promises
        activePromises.forEach(p => p.then(() => activePromises.delete(p)).catch(() => activePromises.delete(p)));

        // Wait if we're at max concurrency
        while (activePromises.size >= (params.concurrency ?? 1)) {
          await Promise.race(activePromises);
        }

        // Queue the next batch
        const promise = processBatch(batchRange, actualIndex);
        activePromises.add(promise);
      }

      // Wait for all remaining batches to complete
      await Promise.all(activePromises);

      // Flush any remaining metrics in the buffer
      if (metricsBuffer.length > 0) {
        const toFlush = metricsBuffer;
        metricsBuffer = [];
        await flushBuffer(toFlush);
      }

      // Wait for all flushes to complete
      await Promise.all(activeFlushes);

      progressBar.complete(name, totalMetrics);
    } catch (error) {
      progressBar.error(name, error);
      throw error;
    }
  }

  console.log('All migrations completed successfully');

  // Clear progress file on successful completion
  if (!params.dryRun) {
    await progressBar.clearProgress();
  }
}

// CLI entry point
async function main() {
  console.log('=== Metric Backfill Script Starting ===');
  console.log(`Node version: ${process.version}`);
  console.log(`Working directory: ${process.cwd()}`);

  const args = process.argv.slice(2);
  console.log(`CLI arguments: ${args.join(' ')}`);

  const params: MigrationParams = {
    concurrency: 10,
    insertBatchSize: 10000,
  };

  // Parse CLI arguments
  console.log('Parsing CLI arguments...');
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

  console.log('Final parameters:', JSON.stringify(params, null, 2));
  console.log('Starting migration process...\n');

  try {
    await runMigrations(migrationPackages, params);
    console.log('\n=== Migration completed successfully ===');
    process.exit(0);
  } catch (error) {
    console.error('\n=== Migration failed ===', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Unhandled error in main:', error);
    process.exit(1);
  });
}
