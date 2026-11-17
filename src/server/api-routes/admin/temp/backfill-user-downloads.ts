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
    const endDate = new Date(); // Backfill up to now

    const results: Array<{
      month: string;
      status: string;
      error?: string;
      duration?: number;
      rows?: number;
    }> = [];

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
        // Insert download events into userModelDownloads table
        const result = await clickhouse.$query<{ rows: number }>`
          INSERT INTO userModelDownloads (userId, modelVersionId, lastDownloaded)
          SELECT
            userId,
            modelVersionId,
            time as lastDownloaded
          FROM modelVersionEvents
          WHERE type = 'Download'
            AND time >= parseDateTime64BestEffort('${startISO}')
            AND time < parseDateTime64BestEffort('${endISO}')
            AND userId > 0
            AND modelVersionId > 0
        `;

        const duration = Date.now() - startTime;

        // ClickHouse INSERT doesn't return row count in the same way
        // We can query to see how many were inserted
        const countResult = await clickhouse.$query<{ count: number }>`
          SELECT count() as count
          FROM userModelDownloads
          WHERE toYYYYMM(lastDownloaded) = toYYYYMM(parseDateTime64BestEffort('${startISO}'))
        `;

        const rows = countResult[0]?.count || 0;

        console.log(
          `✓ Completed month: ${monthLabel} in ${duration}ms (${rows.toLocaleString()} rows)`
        );
        results.push({ month: monthLabel, status: 'success', duration, rows });
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
    const totalRows = results.reduce((sum, r) => sum + (r.rows || 0), 0);

    console.log('\n=== Backfill Summary ===');
    console.log(`Total months processed: ${results.length}`);
    console.log(`Successful: ${successful}`);
    console.log(`Failed: ${failed}`);
    console.log(`Total rows inserted: ${totalRows.toLocaleString()}`);
    console.log(`Total duration: ${totalDuration}ms`);

    res.status(200).json({
      success: true,
      summary: {
        total: results.length,
        successful,
        failed,
        totalRows,
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
