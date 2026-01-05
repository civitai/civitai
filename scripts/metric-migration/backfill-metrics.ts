/**
 * Backfill metrics from PostgreSQL to ClickHouse
 *
 * Usage:
 *   npx ts-node scripts/metric-migration/backfill-metrics.ts --table BountyMetric
 *   npx ts-node scripts/metric-migration/backfill-metrics.ts --table BountyMetric --date 2025-01-21
 *   npx ts-node scripts/metric-migration/backfill-metrics.ts --table BountyMetric --dry-run
 *   npx ts-node scripts/metric-migration/backfill-metrics.ts --table BountyMetric --batch-size 500
 */

import { clickhouse } from '~/server/clickhouse/client';
import { getClient, type AugmentedPool } from '~/server/db/db-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import {
  metricTableConfigs,
  availableTables,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  BACKFILL_VERSION,
  BACKFILL_USER_ID,
  CLICKHOUSE_TABLE,
  type MetricTableConfig,
} from './metric-backfill-config';

const log = createLogger('metric-backfill', 'cyan');

// Retry helper with exponential backoff
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number; name?: string } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, name = 'operation' } = options;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt) {
        log(`[ERROR] ${name} failed after ${maxRetries} attempts: ${lastError.message}`);
        throw lastError;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1); // Exponential backoff
      log(`[RETRY] ${name} failed (attempt ${attempt}/${maxRetries}): ${lastError.message}`);
      log(`[RETRY] Waiting ${delayMs}ms before retry...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

// Types
interface EntityMetricEvent {
  entityType: string;
  entityId: number;
  userId: number;
  metricType: string;
  metricValue: number;
  version: number;
  createdAt: Date;
}

interface CliArgs {
  table: string;
  date: Date;
  dryRun: boolean;
  batchSize: number;
  concurrency: number;
  start?: number;
  end?: number;
}

// Parse CLI arguments
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    table: '',
    date: new Date(),
    dryRun: false,
    batchSize: DEFAULT_BATCH_SIZE,
    concurrency: DEFAULT_CONCURRENCY,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--table':
      case '-t':
        result.table = args[++i];
        break;
      case '--date':
      case '-d':
        result.date = new Date(args[++i]);
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--batch-size':
      case '-b':
        result.batchSize = parseInt(args[++i], 10);
        break;
      case '--concurrency':
      case '-c':
        result.concurrency = parseInt(args[++i], 10);
        break;
      case '--start':
      case '-s':
        result.start = parseInt(args[++i], 10);
        break;
      case '--end':
      case '-e':
        result.end = parseInt(args[++i], 10);
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
Backfill metrics from PostgreSQL to ClickHouse

Usage:
  npx ts-node scripts/metric-migration/backfill-metrics.ts --table <table> [options]

Options:
  --table, -t <name>       PostgreSQL metric table to backfill (required)
  --date, -d <date>        createdAt date for backfilled records (default: today)
  --dry-run                Show what would be done without inserting
  --batch-size, -b <n>     ID range size for processing (default: ${DEFAULT_BATCH_SIZE})
  --concurrency, -c <n>    Concurrency level (default: ${DEFAULT_CONCURRENCY})
  --start, -s <id>         Start ID (skip range query, useful for resuming)
  --end, -e <id>           End ID (skip range query, useful for resuming)
  --help, -h               Show this help message

Available tables:
  ${availableTables.join('\n  ')}

Examples:
  npx ts-node scripts/metric-migration/backfill-metrics.ts --table BountyMetric
  npx ts-node scripts/metric-migration/backfill-metrics.ts --table BountyMetric --dry-run
  npx ts-node scripts/metric-migration/backfill-metrics.ts --table ImageMetric --batch-size 500
  `);
}

function validateArgs(args: CliArgs): void {
  if (!args.table) {
    console.error('Error: --table is required');
    printHelp();
    process.exit(1);
  }

  if (!availableTables.includes(args.table)) {
    console.error(`Error: Unknown table "${args.table}"`);
    console.error(`Available tables: ${availableTables.join(', ')}`);
    process.exit(1);
  }

  if (isNaN(args.date.getTime())) {
    console.error('Error: Invalid date format');
    process.exit(1);
  }

  if (args.batchSize <= 0) {
    console.error('Error: Batch size must be positive');
    process.exit(1);
  }
}

// Delete existing backfill data for an entity type
async function deleteExistingBackfillData(entityType: string, dryRun: boolean): Promise<void> {
  if (!clickhouse) {
    throw new Error('ClickHouse client not initialized');
  }

  const deleteQuery = `
    ALTER TABLE ${CLICKHOUSE_TABLE}
    DELETE WHERE entityType = '${entityType}'
      AND userId = ${BACKFILL_USER_ID}
      AND version = ${BACKFILL_VERSION}
  `;

  if (dryRun) {
    log(`[DRY RUN] Would execute: ${deleteQuery}`);
    return;
  }

  log(`Deleting existing backfill data for ${entityType}...`);
  await clickhouse.$exec(deleteQuery);
  log(`Deleted existing backfill data for ${entityType}`);

  // Wait for mutations to complete (ClickHouse deletes are async)
  log('Waiting for delete mutation to complete...');
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

// Fetch ID range from PostgreSQL (efficient - uses index)
async function fetchIdRange(
  pg: AugmentedPool,
  config: MetricTableConfig
): Promise<{ minId: number; maxId: number; count: number }> {
  const query = `
    SELECT
      MIN("${config.idField}") as "minId",
      MAX("${config.idField}") as "maxId",
      COUNT(DISTINCT "${config.idField}") as count
    FROM "${config.table}"
    WHERE timeframe = 'AllTime'
  `;

  const { result } = await pg.cancellableQuery<{ minId: number; maxId: number; count: string }>(
    query
  );
  const rows = await result();
  const row = rows[0];
  return {
    minId: row?.minId ?? 0,
    maxId: row?.maxId ?? 0,
    count: parseInt(row?.count ?? '0', 10),
  };
}

// Fetch metrics for an ID range (inclusive)
async function fetchMetricsByRange(
  pg: AugmentedPool,
  config: MetricTableConfig,
  startId: number,
  endId: number
): Promise<Record<string, any>[]> {
  const columns = [config.idField, ...config.metrics.map((m) => m.pgColumn)];
  const columnList = columns.map((c) => `"${c}"`).join(', ');

  const query = `
    SELECT ${columnList}
    FROM "${config.table}"
    WHERE "${config.idField}" >= $1
      AND "${config.idField}" < $2
      AND timeframe = 'AllTime'
  `;

  const { result } = await pg.cancellableQuery<Record<string, any>>(query, [startId, endId]);
  return result();
}

// Transform PostgreSQL rows to ClickHouse events
function transformToEvents(
  rows: Record<string, any>[],
  config: MetricTableConfig,
  createdAt: Date
): EntityMetricEvent[] {
  const events: EntityMetricEvent[] = [];

  for (const row of rows) {
    const entityId = row[config.idField];

    for (const mapping of config.metrics) {
      const value = row[mapping.pgColumn];

      // Only include non-zero values
      if (value && value > 0) {
        events.push({
          entityType: config.entityType,
          entityId,
          userId: BACKFILL_USER_ID,
          metricType: mapping.chMetricType,
          metricValue: value,
          version: BACKFILL_VERSION,
          createdAt,
        });
      }
    }
  }

  return events;
}

// Insert events to ClickHouse
async function insertToClickHouse(events: EntityMetricEvent[], dryRun: boolean): Promise<void> {
  if (!clickhouse) {
    throw new Error('ClickHouse client not initialized');
  }

  if (events.length === 0) {
    return;
  }

  if (dryRun) {
    log(`[DRY RUN] Would insert ${events.length} events`);
    if (events.length > 0) {
      log(`[DRY RUN] Sample event: ${JSON.stringify(events[0])}`);
    }
    return;
  }

  await clickhouse.insert({
    table: CLICKHOUSE_TABLE,
    values: events,
    format: 'JSONEachRow',
  });
}

// Process using range-based batching (memory efficient for large tables)
async function processRanges(
  pg: AugmentedPool,
  config: MetricTableConfig,
  range: { minId: number; maxId: number; count: number },
  args: CliArgs
): Promise<{ totalEvents: number; totalEntities: number }> {
  const { batchSize, concurrency, date, dryRun } = args;
  const { minId, maxId, count } = range;

  // Calculate range size based on batch size
  // We use ID ranges, not exact counts, so ranges might have varying entity counts
  const rangeSize = batchSize;
  const totalRanges = Math.ceil((maxId - minId + 1) / rangeSize);

  log(`Processing ~${count} entities in ID range [${minId}, ${maxId}]`);
  log(`Using ${totalRanges} ranges of size ${rangeSize} (concurrency: ${concurrency})`);

  let totalEvents = 0;
  let totalEntities = 0;
  let processedRanges = 0;

  // Create task generator for limitConcurrency
  let currentStart = minId;
  const taskGenerator = () => {
    if (currentStart > maxId) return null;

    const rangeStart = currentStart;
    const rangeEnd = Math.min(currentStart + rangeSize, maxId + 1);
    currentStart = rangeEnd;

    return async () => {
      const rows = await withRetry(() => fetchMetricsByRange(pg, config, rangeStart, rangeEnd), {
        name: `fetch range [${rangeStart}, ${rangeEnd})`,
      });
      const events = transformToEvents(rows, config, date);

      await withRetry(() => insertToClickHouse(events, dryRun), {
        name: `insert range [${rangeStart}, ${rangeEnd})`,
      });

      totalEvents += events.length;
      totalEntities += rows.length;
      processedRanges++;

      const pct = (((rangeEnd - minId) / (maxId - minId + 1)) * 100).toFixed(1);
      log(
        `Range [${rangeStart}, ${rangeEnd}): ${rows.length} entities, ${events.length} events (${pct}% complete)`
      );
    };
  };

  await limitConcurrency(taskGenerator, concurrency);

  return { totalEvents, totalEntities };
}

// Main function
async function main(): Promise<void> {
  console.log('Metric Backfill Script');
  const args = parseArgs();
  validateArgs(args);

  const config = metricTableConfigs[args.table];
  log(`Starting backfill for ${args.table} (${config.entityType})`);
  log(
    `Options: date=${args.date.toISOString()}, dryRun=${args.dryRun}, batchSize=${args.batchSize}`
  );

  if (!clickhouse) {
    throw new Error(
      'ClickHouse client not initialized. Check CLICKHOUSE_HOST environment variable.'
    );
  }

  // Initialize PostgreSQL connection
  const pg = getClient({ instance: 'primaryRead' });

  try {
    // Step 1: Delete existing backfill data
    await deleteExistingBackfillData(config.entityType, args.dryRun);

    // Step 2: Get ID range (from args or query)
    let range: { minId: number; maxId: number; count: number };

    if (args.start !== undefined && args.end !== undefined) {
      log(`Using provided ID range: [${args.start}, ${args.end}]`);
      range = { minId: args.start, maxId: args.end, count: -1 }; // count unknown when manually specified
    } else {
      log(`Fetching ID range from ${config.table}...`);
      const fetchedRange = await fetchIdRange(pg, config);
      range = {
        minId: args.start ?? fetchedRange.minId,
        maxId: args.end ?? fetchedRange.maxId,
        count: fetchedRange.count,
      };
      log(`ID Range: min=${range.minId}, max=${range.maxId}`);
      if (range.count >= 0) {
        log(`Total entities: ${range.count.toLocaleString()}`);
        log(
          `ID span: ${(range.maxId - range.minId + 1).toLocaleString()} (density: ${(
            (range.count / (range.maxId - range.minId + 1)) *
            100
          ).toFixed(1)}%)`
        );
      }
    }

    if (range.count === 0 || range.minId > range.maxId) {
      log('No entities to process. Exiting.');
      return;
    }

    // Step 3: Process in ID ranges
    const startTime = Date.now();
    const { totalEvents, totalEntities } = await processRanges(pg, config, range, args);
    const duration = (Date.now() - startTime) / 1000;

    // Summary
    log('');
    log('=== Backfill Complete ===');
    log(`Table: ${args.table}`);
    log(`Entity Type: ${config.entityType}`);
    log(`Entities Processed: ${totalEntities}`);
    log(`Events Created: ${totalEvents}`);
    log(`Duration: ${duration.toFixed(2)}s`);
    log(`Rate: ${(totalEntities / duration).toFixed(0)} entities/s`);
    if (args.dryRun) {
      log('[DRY RUN] No data was actually inserted');
    }
  } finally {
    await pg.end();
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
