import type { NextApiRequest, NextApiResponse } from 'next';
import { clickhouse } from '~/server/clickhouse/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    if (!clickhouse) {
      throw new Error('ClickHouse client not available');
    }

    // Configuration
    const startDate = new Date('2023-01-01T00:00:00Z');
    const endDate = new Date('2025-11-06T17:49:15Z');

    const results: Array<{ month: string; status: string; error?: string; duration?: number }> = [];

    // Iterate through each month
    let currentStart = new Date(startDate);

    while (currentStart < endDate) {
      // Calculate month boundaries
      const currentEnd = new Date(currentStart);
      currentEnd.setUTCMonth(currentEnd.getUTCMonth() + 1);

      // Use the smaller of currentEnd or endDate
      const batchEnd = currentEnd < endDate ? currentEnd : endDate;

      // Format dates for ClickHouse (without milliseconds)
      const startISO = currentStart.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const endISO = batchEnd.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const monthLabel = `${currentStart.getUTCFullYear()}-${String(
        currentStart.getUTCMonth() + 1
      ).padStart(2, '0')}`;

      console.log(`Processing month: ${monthLabel} (${startISO} to ${endISO})`);

      try {
        const startTime = Date.now();

        // Execute the backfill query for this month
        await clickhouse.$query(`
          INSERT INTO entityMetricDailyAgg_new
          SELECT
              entityType,
              entityId,
              metricType,
              toDate(createdAt) AS day,
              sum(metricValue) AS total
          FROM entityMetricEvents_new
          WHERE createdAt >= parseDateTime64BestEffort('${startISO}') AND createdAt < parseDateTime64BestEffort('${endISO}')
          GROUP BY entityType, entityId, metricType, day
        `);

        const duration = Date.now() - startTime;

        console.log(`✓ Completed month: ${monthLabel} in ${duration}ms`);
        results.push({ month: monthLabel, status: 'success', duration });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`✗ Failed month: ${monthLabel}`, errorMessage);
        results.push({ month: monthLabel, status: 'error', error: errorMessage });
      }

      // Move to next month
      currentStart = new Date(currentEnd);
    }

    // Summary
    const successful = results.filter((r) => r.status === 'success').length;
    const failed = results.filter((r) => r.status === 'error').length;
    const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0);

    console.log('\n=== Backfill Summary ===');
    console.log(`Total months processed: ${results.length}`);
    console.log(`Successful: ${successful}`);
    console.log(`Failed: ${failed}`);
    console.log(`Total duration: ${totalDuration}ms`);

    res.status(200).json({
      success: true,
      summary: {
        total: results.length,
        successful,
        failed,
        totalDuration,
      },
      results,
    });
  } catch (e) {
    console.error('Backfill error:', e);
    const errorMessage = e instanceof Error ? e.message : String(e);
    res.status(500).json({ success: false, error: errorMessage });
  }
});
