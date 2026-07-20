import { createClient } from '@clickhouse/client';
import * as dotenv from 'dotenv';

dotenv.config();

interface BackfillProgress {
  currentMonth: Date;
  endDate: Date;
  matViewStart: Date;
}

async function setupClickhouseRollupView() {
  const clickhouseUrl = process.env.CLICKHOUSE_URL;
  if (!clickhouseUrl) {
    throw new Error('CLICKHOUSE_URL is not defined');
  }

  // Default start date for backfill
  const backfillStartDate = process.env.BACKFILL_START_DATE || '2022-11-01';

  const client = createClient({
    url: clickhouseUrl,
  });

  try {
    console.log('Setting up ClickHouse rollup view and backing table...\n');

    // Step 1: Create backing table
    console.log('Creating backing table...');
    const createBackingTableQuery = `
      CREATE TABLE IF NOT EXISTS entityMetricDailyAgg
      (
          entityType LowCardinality(String),
          entityId   Int32,
          metricType LowCardinality(String),
          day        Date,
          total      Int64
      )
      ENGINE = SummingMergeTree
      ORDER BY (entityType, entityId, metricType, day)
      SETTINGS index_granularity = 8192
    `;

    await client.exec({
      query: createBackingTableQuery,
    });
    console.log('  ✓ Backing table entityMetricDailyAgg created\n');

    // Step 2: Create Materialized View
    console.log('Creating materialized view...');
    const createMatViewQuery = `
      CREATE MATERIALIZED VIEW IF NOT EXISTS entityMetricDaily
      TO entityMetricDailyAgg
      AS
      SELECT
          entityType,
          entityId,
          metricType,
          toDate(createdAt) AS day,
          sum(metricValue) AS total
      FROM entityMetricEvents
      GROUP BY entityType, entityId, metricType, day
    `;

    await client.exec({
      query: createMatViewQuery,
    });
    console.log('  ✓ Materialized view entityMetricDaily created\n');

    // Step 3: Get time of mat view creation
    console.log('Recording materialized view creation time...');
    const matViewStartResult = await client.query({
      query: 'SELECT now() as matViewStart',
      format: 'JSONEachRow',
    });
    const matViewStartData = await matViewStartResult.json() as Array<{matViewStart: string}>;
    const matViewStart = new Date(matViewStartData[0].matViewStart);
    console.log(`  ✓ Materialized view created at: ${matViewStart.toISOString()}\n`);

    // Step 4: Backfill week by week
    console.log(`Starting backfill from ${backfillStartDate}...\n`);

    const startDate = new Date(backfillStartDate);
    // Start from the Monday of the week containing the start date
    let currentWeek = new Date(startDate);
    currentWeek.setDate(currentWeek.getDate() - currentWeek.getDay() + 1);
    currentWeek.setHours(0, 0, 0, 0);

    let totalWeeks = 0;
    let processedWeeks = 0;

    // Calculate total weeks for progress tracking
    const tempDate = new Date(currentWeek);
    while (tempDate < matViewStart) {
      totalWeeks++;
      tempDate.setDate(tempDate.getDate() + 7);
    }

    while (currentWeek < matViewStart) {
      const nextWeek = new Date(currentWeek);
      nextWeek.setDate(nextWeek.getDate() + 7);
      processedWeeks++;

      const weekStr = currentWeek.toISOString().slice(0, 10);
      const nextWeekStr = nextWeek.toISOString().slice(0, 10);
      console.log(`[${processedWeeks}/${totalWeeks}] Processing week ${weekStr} to ${nextWeekStr}...`);

      const backfillQuery = `
        INSERT INTO entityMetricDailyAgg
        SELECT
            entityType,
            entityId,
            metricType,
            toDate(createdAt) AS day,
            sum(metricValue) AS total
        FROM entityMetricEvents
        WHERE createdAt >= '${weekStr}'
          AND createdAt < '${nextWeekStr}'
        GROUP BY entityType, entityId, metricType, day
      `;

      const startTime = Date.now();

      try {
        const result = await client.exec({
          query: backfillQuery,
        });

        // Get row count for the week being processed
        const countQuery = `
          SELECT count(*) as rowCount
          FROM entityMetricEvents
          WHERE createdAt >= '${weekStr}'
            AND createdAt < '${nextWeekStr}'
        `;

        const countResult = await client.query({
          query: countQuery,
          format: 'JSONEachRow',
        });
        const countData = await countResult.json() as Array<{rowCount: string}>;
        const rowCount = parseInt(countData[0].rowCount);

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`  ✓ Processed ${rowCount.toLocaleString()} rows in ${duration}s`);

      } catch (error) {
        console.error(`  ✗ Error processing week ${weekStr}:`, error);
        throw error;
      }

      currentWeek = nextWeek;
    }

    console.log('\n✅ Backfill complete!');

    // Step 5: Verify the data
    console.log('\nVerifying aggregated data...');

    const verifyQuery = `
      SELECT
        count(*) as totalRows,
        min(day) as earliestDay,
        max(day) as latestDay,
        uniq(entityType) as uniqueEntityTypes,
        uniq(metricType) as uniqueMetricTypes,
        sum(total) as totalMetricValue
      FROM entityMetricDailyAgg
    `;

    const verifyResult = await client.query({
      query: verifyQuery,
      format: 'JSONEachRow',
    });

    const verifyData = await verifyResult.json() as Array<{
      totalRows: string;
      earliestDay: string;
      latestDay: string;
      uniqueEntityTypes: string;
      uniqueMetricTypes: string;
      totalMetricValue: string;
    }>;

    const stats = verifyData[0];
    console.log('Aggregation statistics:');
    console.log(`  - Total rows: ${parseInt(stats.totalRows).toLocaleString()}`);
    console.log(`  - Date range: ${stats.earliestDay} to ${stats.latestDay}`);
    console.log(`  - Unique entity types: ${stats.uniqueEntityTypes}`);
    console.log(`  - Unique metric types: ${stats.uniqueMetricTypes}`);
    console.log(`  - Total metric value: ${parseInt(stats.totalMetricValue).toLocaleString()}`);

    // Sample of data by entity type
    console.log('\nSample aggregations by entity type:');
    const sampleQuery = `
      SELECT
        entityType,
        count(*) as rows,
        sum(total) as totalValue
      FROM entityMetricDailyAgg
      GROUP BY entityType
      ORDER BY rows DESC
      LIMIT 10
    `;

    const sampleResult = await client.query({
      query: sampleQuery,
      format: 'JSONEachRow',
    });

    const sampleData = await sampleResult.json() as Array<{
      entityType: string;
      rows: string;
      totalValue: string;
    }>;

    sampleData.forEach(row => {
      console.log(`  - ${row.entityType}: ${parseInt(row.rows).toLocaleString()} rows, total value: ${parseInt(row.totalValue).toLocaleString()}`);
    });

  } catch (error) {
    console.error('Error setting up ClickHouse rollup view:', error);
    throw error;
  } finally {
    await client.close();
  }
}

// Add option to drop existing tables for fresh setup
async function dropExistingRollupTables() {
  const clickhouseUrl = process.env.CLICKHOUSE_URL;
  if (!clickhouseUrl) {
    throw new Error('CLICKHOUSE_URL is not defined');
  }

  const client = createClient({
    url: clickhouseUrl,
  });

  try {
    console.log('Dropping existing rollup tables...\n');

    console.log('Dropping materialized view...');
    await client.exec({
      query: 'DROP VIEW IF EXISTS entityMetricDaily',
    });
    console.log('  ✓ Materialized view dropped\n');

    console.log('Dropping backing table...');
    await client.exec({
      query: 'DROP TABLE IF EXISTS entityMetricDailyAgg',
    });
    console.log('  ✓ Backing table dropped\n');

  } finally {
    await client.close();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const shouldDropFirst = args.includes('--drop-existing');

  (async () => {
    try {
      if (shouldDropFirst) {
        await dropExistingRollupTables();
      }
      await setupClickhouseRollupView();
    } catch (error) {
      console.error('Failed to setup ClickHouse rollup view:', error);
      process.exit(1);
    }
  })();
}

export { setupClickhouseRollupView, dropExistingRollupTables };