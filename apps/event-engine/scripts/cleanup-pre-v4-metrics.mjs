#!/usr/bin/env node

/**
 * Cleanup Pre-V4 Entity Metrics
 *
 * This script deletes all metric events with version < 4 that were created
 * BEFORE the V4 backfill started for each entity type. This preserves:
 *   - All V4 records (the backfill data)
 *   - V3 records that came in AFTER the backfill started (live events)
 *
 * Usage:
 *   node scripts/cleanup-pre-v4-metrics.mjs              # Dry run - show what would be deleted
 *   node scripts/cleanup-pre-v4-metrics.mjs --execute    # Actually run the deletions
 *
 * Options:
 *   --execute       Actually run the DELETE statements (default is dry-run)
 *   --timeout <s>   Query timeout in seconds (default: 120)
 */

import { createClient } from '@clickhouse/client';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from skill directory
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '../.claude/skills/clickhouse-query/.env');

// Simple .env parser
function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    console.error('Error: .env file not found at', ENV_PATH);
    console.error('Please set up the ClickHouse skill first.');
    process.exit(1);
  }

  try {
    const envContent = readFileSync(ENV_PATH, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (e) {
    console.error('Error: Could not load .env file:', e.message);
    process.exit(1);
  }
}

loadEnv();

// Parse arguments
const args = process.argv.slice(2);
let execute = false;
let timeoutSeconds = 120;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--execute') {
    execute = true;
  } else if (arg === '--timeout' || arg === '-t') {
    const val = args[++i];
    if (!val || isNaN(parseInt(val, 10))) {
      console.error('Error: --timeout requires a number (seconds)');
      process.exit(1);
    }
    timeoutSeconds = parseInt(val, 10);
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
Cleanup Pre-V4 Entity Metrics

Usage:
  node scripts/cleanup-pre-v4-metrics.mjs              # Dry run - show what would be deleted
  node scripts/cleanup-pre-v4-metrics.mjs --execute   # Actually run the deletions

Options:
  --execute       Actually run the DELETE statements (default is dry-run)
  --timeout <s>   Query timeout in seconds (default: 120)
  --help, -h      Show this help message
`);
    process.exit(0);
  }
}

// Validate environment
if (!process.env.CLICKHOUSE_HOST || !process.env.CLICKHOUSE_USERNAME) {
  console.error('Error: CLICKHOUSE_HOST and CLICKHOUSE_USERNAME must be set');
  process.exit(1);
}

const TABLE_NAME = 'entityMetricEvents_month';

async function main() {
  const client = createClient({
    host: process.env.CLICKHOUSE_HOST,
    username: process.env.CLICKHOUSE_USERNAME,
    password: process.env.CLICKHOUSE_PASSWORD,
    request_timeout: timeoutSeconds * 1000,
    clickhouse_settings: {
      max_execution_time: timeoutSeconds,
    },
  });

  try {
    console.log(`Connected to ClickHouse (timeout: ${timeoutSeconds}s)\n`);
    console.log(execute ? '*** EXECUTE MODE - Changes will be made ***\n' : '*** DRY RUN MODE - No changes will be made ***\n');

    // Step 1: Find all entity types with V4 records
    console.log('Finding entity types with V4 records...\n');

    const v4EntitiesResult = await client.query({
      query: `
        SELECT
          entityType,
          min(createdAt) as backfillCutoff,
          count() as v4Count
        FROM ${TABLE_NAME}
        WHERE version = 4
        GROUP BY entityType
        ORDER BY entityType
      `,
      format: 'JSONEachRow',
    });

    const v4Entities = await v4EntitiesResult.json();

    if (v4Entities.length === 0) {
      console.log('No entity types with V4 records found. Nothing to clean up.');
      await client.close();
      return;
    }

    console.log('Entity types with V4 backfill:\n');
    console.log('─'.repeat(80));
    console.log(`${'Entity Type'.padEnd(20)} ${'Backfill Cutoff'.padEnd(25)} ${'V4 Count'.padStart(15)}`);
    console.log('─'.repeat(80));

    for (const entity of v4Entities) {
      console.log(
        `${entity.entityType.padEnd(20)} ${entity.backfillCutoff.padEnd(25)} ${entity.v4Count.toString().padStart(15)}`
      );
    }
    console.log('─'.repeat(80));
    console.log('');

    // Step 2: For each entity type, calculate what will be deleted vs kept
    console.log('Calculating records to delete vs keep...\n');

    const deletionPlan = [];

    for (const entity of v4Entities) {
      const statsResult = await client.query({
        query: `
          SELECT
            version,
            countIf(createdAt < '${entity.backfillCutoff}') as toDelete,
            countIf(createdAt >= '${entity.backfillCutoff}') as toKeep
          FROM ${TABLE_NAME}
          WHERE entityType = '${entity.entityType}'
          GROUP BY version
          ORDER BY version
        `,
        format: 'JSONEachRow',
      });

      const stats = await statsResult.json();

      let totalToDelete = 0;
      let totalToKeep = 0;

      for (const row of stats) {
        if (parseInt(row.version) < 4) {
          totalToDelete += parseInt(row.toDelete);
          totalToKeep += parseInt(row.toKeep);
        } else {
          totalToKeep += parseInt(row.toDelete) + parseInt(row.toKeep);
        }
      }

      deletionPlan.push({
        entityType: entity.entityType,
        backfillCutoff: entity.backfillCutoff,
        toDelete: totalToDelete,
        toKeep: totalToKeep,
        stats,
      });
    }

    // Display deletion plan
    console.log('Deletion Plan:\n');
    console.log('─'.repeat(90));
    console.log(`${'Entity Type'.padEnd(20)} ${'Cutoff'.padEnd(25)} ${'To Delete'.padStart(15)} ${'To Keep'.padStart(15)}`);
    console.log('─'.repeat(90));

    let grandTotalDelete = 0;
    let grandTotalKeep = 0;

    for (const plan of deletionPlan) {
      console.log(
        `${plan.entityType.padEnd(20)} ${plan.backfillCutoff.padEnd(25)} ${plan.toDelete.toLocaleString().padStart(15)} ${plan.toKeep.toLocaleString().padStart(15)}`
      );
      grandTotalDelete += plan.toDelete;
      grandTotalKeep += plan.toKeep;
    }

    console.log('─'.repeat(90));
    console.log(
      `${'TOTAL'.padEnd(20)} ${''.padEnd(25)} ${grandTotalDelete.toLocaleString().padStart(15)} ${grandTotalKeep.toLocaleString().padStart(15)}`
    );
    console.log('─'.repeat(90));
    console.log('');

    // Step 3: Execute deletions if --execute flag is set
    if (!execute) {
      console.log('Dry run complete. To execute the deletions, run with --execute flag.');
      console.log('');
      console.log('Example:');
      console.log('  node scripts/cleanup-pre-v4-metrics.mjs --execute');
      await client.close();
      return;
    }

    // Confirm execution
    console.log(`About to delete ${grandTotalDelete.toLocaleString()} records across ${deletionPlan.length} entity types.`);
    console.log('');

    for (const plan of deletionPlan) {
      if (plan.toDelete === 0) {
        console.log(`[${plan.entityType}] No records to delete, skipping.`);
        continue;
      }

      console.log(`[${plan.entityType}] Deleting ${plan.toDelete.toLocaleString()} records (before ${plan.backfillCutoff})...`);

      const deleteQuery = `
        ALTER TABLE ${TABLE_NAME}
        DELETE WHERE entityType = '${plan.entityType}'
          AND version < 4
          AND createdAt < '${plan.backfillCutoff}'
      `;

      const start = Date.now();
      await client.command({ query: deleteQuery });
      const elapsed = Date.now() - start;

      console.log(`[${plan.entityType}] DELETE mutation submitted in ${elapsed}ms`);
    }

    console.log('');
    console.log('All DELETE mutations submitted. Mutations run asynchronously in the background.');
    console.log('');
    console.log('To check mutation progress, run:');
    console.log(`
  node .claude/skills/clickhouse-query/query.mjs "
    SELECT
      mutation_id,
      command,
      create_time,
      is_done,
      parts_to_do,
      latest_fail_reason
    FROM system.mutations
    WHERE table = '${TABLE_NAME}'
      AND is_done = 0
    ORDER BY create_time DESC
  "
`);

  } catch (err) {
    if (err.message.includes('timeout') || err.message.includes('TIMEOUT')) {
      console.error(`Error: Query timed out after ${timeoutSeconds} seconds`);
      console.error('Use --timeout <seconds> to increase the limit if needed.');
    } else {
      console.error('Error:', err.message);
    }
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
