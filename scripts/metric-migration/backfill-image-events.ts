/**
 * Backfill image metric events from PostgreSQL to ClickHouse
 *
 * This script reconstructs individual events from source tables (ImageReaction,
 * CommentV2, CollectionItem, BuzzTip) and inserts them into ClickHouse with
 * deduplication to avoid duplicating existing events.
 *
 * Usage:
 *   # Full backfill from Nov 20, 2025
 *   npx ts-node scripts/metric-migration/backfill-image-events.ts --start-date 2025-11-20
 *
 *   # Specific date range
 *   npx ts-node scripts/metric-migration/backfill-image-events.ts --start-date 2025-11-20 --end-date 2025-12-01
 *
 *   # Single source type
 *   npx ts-node scripts/metric-migration/backfill-image-events.ts --start-date 2025-11-20 --source reactions
 *
 *   # Test specific image IDs
 *   npx ts-node scripts/metric-migration/backfill-image-events.ts --image-ids 123,456,789
 *
 *   # Dry run
 *   npx ts-node scripts/metric-migration/backfill-image-events.ts --start-date 2025-11-20 --dry-run
 */

import fs from 'fs';
import path from 'path';
import { clickhouse } from '~/server/clickhouse/client';
import { getClient, type AugmentedPool } from '~/server/db/db-helpers';

const log = (...args: unknown[]) => console.log('[backfill-image-events]', ...args);

// Constants
const CLICKHOUSE_TABLE = 'entityMetricEvents';
const ENTITY_TYPE = 'Image';
const DEFAULT_BATCH_DAYS = 1;
const INSERT_BATCH_SIZE = 50000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

// Retry helper with exponential backoff
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

      const delayMs = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff
      log(`[RETRY] ${operationName} failed (attempt ${attempt}/${maxRetries}): ${lastError.message}`);
      log(`[RETRY] Waiting ${delayMs}ms before retry...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

// Types
interface ImageEvent {
  entityType: string;
  entityId: number;
  userId: number;
  metricType: string;
  metricValue: number;
  createdAt: Date;
}

interface ExistingEvent {
  entityId: number;
  metricType: string;
  userId: number;
  ts: string; // seconds timestamp as string (truncated for fuzzy matching)
}

interface CliArgs {
  startDate?: Date;
  endDate: Date;
  dryRun: boolean;
  source?: 'reactions' | 'comments' | 'collections' | 'buzz' | 'all';
  imageIds?: number[];
  batchDays: number;
}

type SourceType = 'reactions' | 'comments' | 'collections' | 'buzz';

// Parse CLI arguments
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    endDate: new Date(),
    dryRun: false,
    source: 'all',
    batchDays: DEFAULT_BATCH_DAYS,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--start-date':
      case '-s':
        result.startDate = new Date(args[++i]);
        break;
      case '--end-date':
      case '-e':
        result.endDate = new Date(args[++i]);
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--source':
        result.source = args[++i] as CliArgs['source'];
        break;
      case '--image-ids':
      case '-i':
        result.imageIds = args[++i].split(',').map((id) => parseInt(id.trim(), 10));
        break;
      case '--batch-days':
      case '-b':
        result.batchDays = parseInt(args[++i], 10);
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
Backfill image metric events from PostgreSQL to ClickHouse

Usage:
  npx ts-node scripts/metric-migration/backfill-image-events.ts [options]

Options:
  --start-date, -s <date>   Start date for backfill (required unless --image-ids)
  --end-date, -e <date>     End date for backfill (default: today)
  --dry-run                 Show what would be done without inserting
  --source <type>           Source type: reactions, comments, collections, buzz, all (default: all)
  --image-ids, -i <ids>     Comma-separated image IDs to backfill (ignores date range)
  --batch-days, -b <n>      Days per batch (default: ${DEFAULT_BATCH_DAYS})
  --help, -h                Show this help message

Examples:
  # Full backfill from Nov 20
  npx ts-node scripts/metric-migration/backfill-image-events.ts --start-date 2025-11-20

  # Test specific images
  npx ts-node scripts/metric-migration/backfill-image-events.ts --image-ids 123,456,789

  # Dry run for reactions only
  npx ts-node scripts/metric-migration/backfill-image-events.ts --start-date 2025-11-20 --source reactions --dry-run
  `);
}

function validateArgs(args: CliArgs): void {
  if (!args.imageIds && !args.startDate) {
    console.error('Error: --start-date is required unless using --image-ids');
    printHelp();
    process.exit(1);
  }

  if (args.startDate && isNaN(args.startDate.getTime())) {
    console.error('Error: Invalid start date format');
    process.exit(1);
  }

  if (isNaN(args.endDate.getTime())) {
    console.error('Error: Invalid end date format');
    process.exit(1);
  }

  if (args.source && !['reactions', 'comments', 'collections', 'buzz', 'all'].includes(args.source)) {
    console.error('Error: Invalid source type');
    process.exit(1);
  }

  if (args.imageIds && args.imageIds.some(isNaN)) {
    console.error('Error: Invalid image IDs');
    process.exit(1);
  }
}

// Build event signature for deduplication (truncate to seconds for fuzzy matching)
function buildSignature(event: ImageEvent): string {
  const timestampSeconds = Math.floor(event.createdAt.getTime() / 1000);
  return `${event.entityId}:${event.metricType}:${event.userId}:${timestampSeconds}`;
}

// Format date for ClickHouse (without Z suffix)
function formatDateForClickHouse(date: Date): string {
  return date.toISOString().replace('Z', '').replace('T', ' ');
}

// Write affected image IDs to a file
function writeAffectedImageIds(imageIds: Set<number>, dryRun: boolean): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = dryRun ? 'dry-run-' : '';
  const filename = `${prefix}affected-image-ids-${timestamp}.txt`;
  const filepath = path.join(process.cwd(), 'scripts/metric-migration', filename);

  const content = [...imageIds].join('\n');
  fs.writeFileSync(filepath, content);

  return filepath;
}

// Fetch existing events from ClickHouse for deduplication
async function fetchExistingEvents(
  startDate: Date,
  endDate: Date,
  imageIds?: number[]
): Promise<Set<string>> {
  return withRetry(async () => {
    if (!clickhouse) throw new Error('ClickHouse client not initialized');

    const imageIdFilter = imageIds?.length ? `AND entityId IN (${imageIds.join(',')})` : '';

    const query = `
      SELECT
        entityId,
        metricType,
        userId,
        toString(toUnixTimestamp(createdAt)) as ts
      FROM ${CLICKHOUSE_TABLE}
      WHERE entityType = '${ENTITY_TYPE}'
        AND createdAt >= toDateTime64('${formatDateForClickHouse(startDate)}', 3)
        AND createdAt < toDateTime64('${formatDateForClickHouse(endDate)}', 3)
        ${imageIdFilter}
    `;

    const existing = await clickhouse.$query<ExistingEvent>(query);
    const signatures = new Set<string>();

    for (const row of existing) {
      const sig = `${row.entityId}:${row.metricType}:${row.userId}:${row.ts}`;
      signatures.add(sig);
    }

    return signatures;
  }, 'fetchExistingEvents');
}

// Fetch reaction events from PostgreSQL
async function fetchReactionEvents(
  pg: AugmentedPool,
  startDate: Date,
  endDate: Date,
  imageIds?: number[]
): Promise<ImageEvent[]> {
  return withRetry(async () => {
    const imageIdFilter = imageIds?.length ? `AND "imageId" IN (${imageIds.join(',')})` : '';
    const dateFilter = imageIds?.length
      ? ''
      : `AND "createdAt" >= '${startDate.toISOString()}' AND "createdAt" < '${endDate.toISOString()}'`;

    const query = `
      SELECT
        "imageId" as "entityId",
        "userId",
        'Reaction' || reaction as "metricType",
        1 as "metricValue",
        "createdAt"
      FROM "ImageReaction"
      WHERE 1=1
        ${dateFilter}
        ${imageIdFilter}
      ORDER BY "createdAt"
    `;

    const { result } = await pg.cancellableQuery<{
      entityId: number;
      userId: number;
      metricType: string;
      metricValue: number;
      createdAt: Date;
    }>(query);
    const rows = await result();

    return rows.map((row) => ({
      entityType: ENTITY_TYPE,
      entityId: row.entityId,
      userId: row.userId,
      metricType: row.metricType,
      metricValue: row.metricValue,
      createdAt: row.createdAt,
    }));
  }, 'fetchReactionEvents');
}

// Fetch comment events from PostgreSQL
async function fetchCommentEvents(
  pg: AugmentedPool,
  startDate: Date,
  endDate: Date,
  imageIds?: number[]
): Promise<ImageEvent[]> {
  return withRetry(async () => {
    const imageIdFilter = imageIds?.length ? `AND t."imageId" IN (${imageIds.join(',')})` : '';
    const dateFilter = imageIds?.length
      ? ''
      : `AND c."createdAt" >= '${startDate.toISOString()}' AND c."createdAt" < '${endDate.toISOString()}'`;

    const query = `
      SELECT
        t."imageId" as "entityId",
        c."userId",
        'Comment' as "metricType",
        1 as "metricValue",
        c."createdAt"
      FROM "Thread" t
      JOIN "CommentV2" c ON c."threadId" = t.id
      WHERE t."imageId" IS NOT NULL
        ${dateFilter}
        ${imageIdFilter}
      ORDER BY c."createdAt"
    `;

    const { result } = await pg.cancellableQuery<{
      entityId: number;
      userId: number;
      metricType: string;
      metricValue: number;
      createdAt: Date;
    }>(query);
    const rows = await result();

    return rows.map((row) => ({
      entityType: ENTITY_TYPE,
      entityId: row.entityId,
      userId: row.userId,
      metricType: row.metricType,
      metricValue: row.metricValue,
      createdAt: row.createdAt,
    }));
  }, 'fetchCommentEvents');
}

// Fetch collection events from PostgreSQL
async function fetchCollectionEvents(
  pg: AugmentedPool,
  startDate: Date,
  endDate: Date,
  imageIds?: number[]
): Promise<ImageEvent[]> {
  return withRetry(async () => {
    const imageIdFilter = imageIds?.length ? `AND "imageId" IN (${imageIds.join(',')})` : '';
    const dateFilter = imageIds?.length
      ? ''
      : `AND "createdAt" >= '${startDate.toISOString()}' AND "createdAt" < '${endDate.toISOString()}'`;

    const query = `
      SELECT
        "imageId" as "entityId",
        "addedById" as "userId",
        'Collection' as "metricType",
        1 as "metricValue",
        "createdAt"
      FROM "CollectionItem"
      WHERE "imageId" IS NOT NULL
        ${dateFilter}
        ${imageIdFilter}
      ORDER BY "createdAt"
    `;

    const { result } = await pg.cancellableQuery<{
      entityId: number;
      userId: number;
      metricType: string;
      metricValue: number;
      createdAt: Date;
    }>(query);
    const rows = await result();

    return rows.map((row) => ({
      entityType: ENTITY_TYPE,
      entityId: row.entityId,
      userId: row.userId,
      metricType: row.metricType,
      metricValue: row.metricValue,
      createdAt: row.createdAt,
    }));
  }, 'fetchCollectionEvents');
}

// Fetch buzz/tip events from PostgreSQL
async function fetchBuzzEvents(
  pg: AugmentedPool,
  startDate: Date,
  endDate: Date,
  imageIds?: number[]
): Promise<ImageEvent[]> {
  return withRetry(async () => {
    const imageIdFilter = imageIds?.length ? `AND "entityId" IN (${imageIds.join(',')})` : '';
    const dateFilter = imageIds?.length
      ? ''
      : `AND "createdAt" >= '${startDate.toISOString()}' AND "createdAt" < '${endDate.toISOString()}'`;

    const query = `
      SELECT
        "entityId",
        "fromUserId" as "userId",
        'Buzz' as "metricType",
        amount as "metricValue",
        "createdAt"
      FROM "BuzzTip"
      WHERE "entityType" = 'Image'
        ${dateFilter}
        ${imageIdFilter}
      ORDER BY "createdAt"
    `;

    const { result } = await pg.cancellableQuery<{
      entityId: number;
      userId: number;
      metricType: string;
      metricValue: number;
      createdAt: Date;
    }>(query);
    const rows = await result();

    return rows.map((row) => ({
      entityType: ENTITY_TYPE,
      entityId: row.entityId,
      userId: row.userId,
      metricType: row.metricType,
      metricValue: row.metricValue,
      createdAt: row.createdAt,
    }));
  }, 'fetchBuzzEvents');
}

// Insert events to ClickHouse in batches
async function insertToClickHouse(events: ImageEvent[], dryRun: boolean): Promise<number> {
  if (!clickhouse) throw new Error('ClickHouse client not initialized');
  if (events.length === 0) return 0;

  if (dryRun) {
    log(`[DRY RUN] Would insert ${events.length} events`);
    if (events.length > 0) {
      log(`[DRY RUN] Sample: ${JSON.stringify(events[0])}`);
    }
    return events.length;
  }

  let inserted = 0;
  for (let i = 0; i < events.length; i += INSERT_BATCH_SIZE) {
    const batch = events.slice(i, i + INSERT_BATCH_SIZE);
    const batchNum = Math.floor(i / INSERT_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(events.length / INSERT_BATCH_SIZE);

    await withRetry(async () => {
      await clickhouse.insert({
        table: CLICKHOUSE_TABLE,
        values: batch,
        format: 'JSONEachRow',
      });
    }, `insertToClickHouse batch ${batchNum}/${totalBatches}`);

    inserted += batch.length;
    log(`Inserted batch: ${inserted}/${events.length}`);
  }

  return inserted;
}

// Process a single source type for a date range
async function processSource(
  pg: AugmentedPool,
  sourceType: SourceType,
  startDate: Date,
  endDate: Date,
  existingSignatures: Set<string>,
  dryRun: boolean,
  imageIds?: number[]
): Promise<{ fetched: number; duplicates: number; inserted: number; affectedImageIds: Set<number> }> {
  if (imageIds?.length) {
    log(`Processing ${sourceType} for image IDs: ${imageIds.join(', ')} (all time)`);
  } else {
    log(`Processing ${sourceType} from ${startDate.toISOString()} to ${endDate.toISOString()}`);
  }

  // Fetch events from PostgreSQL
  let events: ImageEvent[];
  switch (sourceType) {
    case 'reactions':
      events = await fetchReactionEvents(pg, startDate, endDate, imageIds);
      break;
    case 'comments':
      events = await fetchCommentEvents(pg, startDate, endDate, imageIds);
      break;
    case 'collections':
      events = await fetchCollectionEvents(pg, startDate, endDate, imageIds);
      break;
    case 'buzz':
      events = await fetchBuzzEvents(pg, startDate, endDate, imageIds);
      break;
  }

  log(`Fetched ${events.length} ${sourceType} events from PostgreSQL`);

  // Filter out duplicates
  const newEvents = events.filter((event) => {
    const sig = buildSignature(event);
    return !existingSignatures.has(sig);
  });

  const duplicates = events.length - newEvents.length;
  log(`Found ${duplicates} duplicates, ${newEvents.length} new events`);

  // Collect affected image IDs
  const affectedImageIds = new Set<number>();
  for (const event of newEvents) {
    affectedImageIds.add(event.entityId);
  }

  // Insert new events
  const inserted = await insertToClickHouse(newEvents, dryRun);

  return { fetched: events.length, duplicates, inserted, affectedImageIds };
}

// Process by image IDs (for testing specific images)
async function processImageIds(
  pg: AugmentedPool,
  imageIds: number[],
  sources: SourceType[],
  dryRun: boolean
): Promise<void> {
  log(`Processing ${imageIds.length} specific image IDs: ${imageIds.join(', ')}`);

  // For image ID mode, we need to fetch all existing events for these images
  const existingSignatures = await fetchExistingEvents(
    new Date('2000-01-01'),
    new Date('2100-01-01'),
    imageIds
  );
  log(`Found ${existingSignatures.size} existing events in ClickHouse`);

  const totals = { fetched: 0, duplicates: 0, inserted: 0 };
  const allAffectedImageIds = new Set<number>();

  for (const sourceType of sources) {
    const result = await processSource(
      pg,
      sourceType,
      new Date('2000-01-01'),
      new Date('2100-01-01'),
      existingSignatures,
      dryRun,
      imageIds
    );
    totals.fetched += result.fetched;
    totals.duplicates += result.duplicates;
    totals.inserted += result.inserted;
    for (const id of result.affectedImageIds) {
      allAffectedImageIds.add(id);
    }
  }

  log('');
  log('=== Image ID Backfill Complete ===');
  log(`Image IDs: ${imageIds.join(', ')}`);
  log(`Total Fetched: ${totals.fetched}`);
  log(`Duplicates Skipped: ${totals.duplicates}`);
  log(`New Events Inserted: ${totals.inserted}`);
  log(`Affected Image IDs: ${allAffectedImageIds.size}`);
  if (allAffectedImageIds.size > 0) {
    const filepath = writeAffectedImageIds(allAffectedImageIds, dryRun);
    log(`Affected Image IDs written to: ${filepath}`);
  }
}

// Process by date range
async function processDateRange(
  pg: AugmentedPool,
  startDate: Date,
  endDate: Date,
  sources: SourceType[],
  batchDays: number,
  dryRun: boolean
): Promise<void> {
  log(`Processing date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);

  const totals = { fetched: 0, duplicates: 0, inserted: 0 };
  const allAffectedImageIds = new Set<number>();
  let currentStart = new Date(startDate);

  while (currentStart < endDate) {
    const currentEnd = new Date(currentStart);
    currentEnd.setDate(currentEnd.getDate() + batchDays);
    if (currentEnd > endDate) {
      currentEnd.setTime(endDate.getTime());
    }

    log('');
    log(`=== Batch: ${currentStart.toISOString().split('T')[0]} to ${currentEnd.toISOString().split('T')[0]} ===`);

    // Fetch existing events for this time range
    const existingSignatures = await fetchExistingEvents(currentStart, currentEnd);
    log(`Found ${existingSignatures.size} existing events in ClickHouse for this batch`);

    for (const sourceType of sources) {
      const result = await processSource(
        pg,
        sourceType,
        currentStart,
        currentEnd,
        existingSignatures,
        dryRun
      );
      totals.fetched += result.fetched;
      totals.duplicates += result.duplicates;
      totals.inserted += result.inserted;
      for (const id of result.affectedImageIds) {
        allAffectedImageIds.add(id);
      }
    }

    currentStart = currentEnd;
  }

  log('');
  log('=== Date Range Backfill Complete ===');
  log(`Date Range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
  log(`Total Fetched: ${totals.fetched}`);
  log(`Duplicates Skipped: ${totals.duplicates}`);
  log(`New Events Inserted: ${totals.inserted}`);
  log(`Affected Image IDs: ${allAffectedImageIds.size}`);
  if (allAffectedImageIds.size > 0) {
    const filepath = writeAffectedImageIds(allAffectedImageIds, dryRun);
    log(`Affected Image IDs written to: ${filepath}`);
  }
}

// Main function
async function main(): Promise<void> {
  console.log('Image Events Backfill Script');
  const args = parseArgs();
  validateArgs(args);

  if (!clickhouse) {
    throw new Error('ClickHouse client not initialized. Check CLICKHOUSE_HOST environment variable.');
  }

  log(`Options: dryRun=${args.dryRun}, source=${args.source}, batchDays=${args.batchDays}`);

  // Initialize PostgreSQL connection
  const pg = getClient({ instance: 'primaryRead' });

  // Determine which sources to process
  const sources: SourceType[] =
    args.source === 'all'
      ? ['reactions', 'comments', 'collections', 'buzz']
      : [args.source as SourceType];

  const startTime = Date.now();

  try {
    if (args.imageIds?.length) {
      // Process specific image IDs
      await processImageIds(pg, args.imageIds, sources, args.dryRun);
    } else if (args.startDate) {
      // Process date range
      await processDateRange(pg, args.startDate, args.endDate, sources, args.batchDays, args.dryRun);
    }

    const duration = (Date.now() - startTime) / 1000;
    log(`Duration: ${duration.toFixed(2)}s`);

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
