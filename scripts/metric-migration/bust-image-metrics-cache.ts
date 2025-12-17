/**
 * Bust image metrics cache for affected images after backfill
 *
 * This script reads image IDs from a file and:
 * 1. Busts their metric cache so the next fetch will pull fresh data from ClickHouse
 * 2. Queues them for search index update so Meilisearch reflects the new metrics
 *
 * Usage:
 *   npm run ts-script scripts/metric-migration/bust-image-metrics-cache.ts -- --file affected-image-ids-2025-12-17T01-00-36-000Z.txt
 *
 *   # Dry run
 *   npm run ts-script scripts/metric-migration/bust-image-metrics-cache.ts -- --file affected-image-ids.txt --dry-run
 */

import fs from 'fs';
import path from 'path';

const log = (...args: unknown[]) => console.log('[bust-image-metrics-cache]', ...args);

const BATCH_SIZE = 10000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

interface CliArgs {
  file: string;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    file: '',
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--file':
      case '-f':
        result.file = args[++i];
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
Bust image metrics cache for affected images after backfill

Usage:
  npm run ts-script scripts/metric-migration/bust-image-metrics-cache.ts -- [options]

Options:
  --file, -f <path>   Path to file containing image IDs (one per line)
  --dry-run           Show what would be done without busting cache
  --help, -h          Show this help message

Examples:
  # Bust cache for all affected images
  npm run ts-script scripts/metric-migration/bust-image-metrics-cache.ts -- --file affected-image-ids-2025-12-17T01-00-36-000Z.txt

  # Dry run
  npm run ts-script scripts/metric-migration/bust-image-metrics-cache.ts -- --file affected-image-ids.txt --dry-run
  `);
}

function validateArgs(args: CliArgs): void {
  if (!args.file) {
    console.error('Error: --file is required');
    printHelp();
    process.exit(1);
  }
}

function readImageIds(filePath: string): number[] {
  // Resolve path relative to script directory if not absolute
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(__dirname, filePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const ids = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseInt(line, 10))
    .filter((id) => !isNaN(id));

  return ids;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries = MAX_RETRIES
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt) {
        log(`[FAILED] ${operationName} failed after ${maxRetries} attempts: ${lastError.message}`);
        throw lastError;
      }

      const delayMs = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      log(`[RETRY] ${operationName} failed (attempt ${attempt}/${maxRetries}): ${lastError.message}`);
      log(`[RETRY] Waiting ${delayMs}ms before retry...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

async function waitForRedisReady(redis: any, timeoutMs = 30000): Promise<void> {
  const startTime = Date.now();

  // Give the cluster client a moment to start connecting
  await new Promise((resolve) => setTimeout(resolve, 2000));

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Check if client is open/ready
      if (redis.isOpen === false || redis.isReady === false) {
        log(`Waiting for Redis connection... (isOpen=${redis.isOpen}, isReady=${redis.isReady})`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      // Try a simple ping to verify connection is ready
      await redis.ping();
      return;
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      // If it's a connection-related error, wait and retry
      if (
        errorMsg.includes('closed') ||
        errorMsg.includes('ECONNREFUSED') ||
        errorMsg.includes('master') ||
        errorMsg.includes('CLUSTERDOWN') ||
        errorMsg.includes('LOADING') ||
        errorMsg.includes('undefined')
      ) {
        log(`Waiting for Redis connection... (${errorMsg.substring(0, 50)})`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        throw error;
      }
    }
  }

  throw new Error(`Redis connection timeout after ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  console.log('Image Metrics Cache Bust Script');
  const args = parseArgs();
  validateArgs(args);

  log(`Options: file=${args.file}, dryRun=${args.dryRun}`);

  // Dynamic imports to avoid loading Redis modules until we need them
  // This allows the environment to be fully loaded first
  log('Loading Redis modules...');

  let redis: any;
  try {
    const redisModule = await import('~/server/redis/client');
    redis = redisModule.redis;
  } catch (error) {
    console.error('Error: Failed to load Redis client module.');
    console.error('Make sure REDIS_URL is set in your environment.');
    console.error('Original error:', error);
    process.exit(1);
  }

  // Check Redis is available
  if (!redis) {
    console.error('Error: Redis client is not initialized.');
    console.error('This usually means env.IS_BUILD is true or environment loading failed.');
    console.error('Make sure REDIS_URL is set and NODE_ENV=development.');
    process.exit(1);
  }

  // Wait for Redis connection to be ready (important for cluster mode)
  log('Waiting for Redis connection to be ready...');
  try {
    await waitForRedisReady(redis);
    log('Redis connection ready');
  } catch (error) {
    console.error('Error: Redis connection failed.');
    console.error('Make sure Redis is running and accessible at the configured REDIS_URL.');
    console.error('Original error:', error);
    process.exit(1);
  }

  // Now load the dependent modules
  const { imageMetricsCache } = await import('~/server/redis/entity-metric-populate');
  const { imagesMetricsSearchIndexUpdateMetrics } = await import('~/server/search-index');
  const { SearchIndexUpdateQueueAction } = await import('~/server/common/enums');

  log('Redis modules loaded successfully');

  // Read image IDs from file
  const imageIds = readImageIds(args.file);
  log(`Loaded ${imageIds.length} image IDs from file`);

  if (imageIds.length === 0) {
    log('No image IDs to process');
    return;
  }

  const startTime = Date.now();
  const totalBatches = Math.ceil(imageIds.length / BATCH_SIZE);

  log(`Processing ${imageIds.length} images in ${totalBatches} batches of ${BATCH_SIZE}`);

  async function bustCacheBatch(batchIds: number[], batchNum: number): Promise<void> {
    if (args.dryRun) {
      log(`[DRY RUN] Would bust cache and queue search index for batch ${batchNum}/${totalBatches} (${batchIds.length} images)`);
      return;
    }

    // Bust Redis cache
    await withRetry(async () => {
      await imageMetricsCache.bust(batchIds);
    }, `bustCache batch ${batchNum}/${totalBatches}`);

    // Queue for search index update
    await withRetry(async () => {
      await imagesMetricsSearchIndexUpdateMetrics.queueUpdate(
        batchIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
    }, `queueSearchIndex batch ${batchNum}/${totalBatches}`);

    log(`Busted cache and queued search index for batch ${batchNum}/${totalBatches} (${batchIds.length} images)`);
  }

  let processed = 0;
  for (let i = 0; i < imageIds.length; i += BATCH_SIZE) {
    const batch = imageIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    await bustCacheBatch(batch, batchNum);
    processed += batch.length;
  }

  const duration = (Date.now() - startTime) / 1000;

  log('');
  log('=== Cache Bust & Search Index Queue Complete ===');
  log(`Total Images: ${imageIds.length}`);
  log(`Duration: ${duration.toFixed(2)}s`);
  log('Actions performed:');
  log('  - Busted Redis metric cache (imageMetricsCache)');
  log('  - Queued for Meilisearch update (imagesMetricsSearchIndexUpdateMetrics)');

  if (args.dryRun) {
    log('[DRY RUN] No cache was actually busted and no search index updates were queued');
  }
}

// Run
main()
  .then(() => {
    log('Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
