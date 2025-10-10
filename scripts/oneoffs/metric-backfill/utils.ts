import fs from 'fs/promises';
import { chunk } from 'lodash-es';
import { env } from '~/env/server';
import { createClient } from '@clickhouse/client';
import type { EntityMetricEvent } from './types';
import { Pool } from 'pg';

export const START_DATE = '2022-11-01 00:00:00.000';
export const CUTOFF_DATE = '2025-10-07 00:00:00.000';

const pgConnString = new URL(env.DATABASE_URL);
if (env.DATABASE_SSL !== false) pgConnString.searchParams.set('sslmode', 'no-verify');
export const pgDb = new Pool({
  connectionString: pgConnString.toString(),
  connectionTimeoutMillis: 0,
  min: 0,
  max: 40,
  application_name: 'metric-backfill',
})

export const clickhouse = createClient({
  host: env.CLICKHOUSE_HOST,
  username: env.CLICKHOUSE_USERNAME,
  password: env.CLICKHOUSE_PASSWORD,
  clickhouse_settings: {
    async_insert: 1,
    wait_for_async_insert: 0,
    output_format_json_quote_64bit_integers: 0, // otherwise they come as strings
  },
});

export class ProgressTracker {
  private progressFile = './metric-backfill-progress.json';
  private packageProgress = new Map<
    string,
    { current: number; total: number; metrics: number; startTime: number }
  >();
  private metricsPerSecond: number[] = [];
  private saveProgressLock: Promise<void> = Promise.resolve();

  start(name: string) {
    console.log(`Starting migration: ${name}`);
    this.packageProgress.set(name, {
      current: 0,
      total: 0,
      metrics: 0,
      startTime: Date.now(),
    });
  }

  setTotal(name: string, total: number) {
    const progress = this.packageProgress.get(name);
    if (progress) {
      progress.total = total;
      console.log(`${name}: ${total} batches to process`);
    }
  }

  async updateBatch(name: string, batchNumber: number, metricsCount: number) {
    const progress = this.packageProgress.get(name);
    if (progress) {
      progress.current = batchNumber;
      progress.metrics += metricsCount;

      const elapsed = (Date.now() - progress.startTime) / 1000;
      const rate = progress.metrics / elapsed;
      this.metricsPerSecond.push(rate);

      // Keep only last 10 entries to prevent unbounded memory growth
      if (this.metricsPerSecond.length > 10) {
        this.metricsPerSecond = this.metricsPerSecond.slice(-10);
      }

      const avgRate =
        this.metricsPerSecond.reduce((a, b) => a + b, 0) / this.metricsPerSecond.length;

      const remaining = progress.total - progress.current;
      const eta = remaining > 0 && avgRate > 0 ? remaining / (avgRate / 1000) : 0;

      console.log(
        `${name}: Batch ${batchNumber}/${progress.total} - ` +
          `${metricsCount} metrics (${progress.metrics} total) - ` +
          `${avgRate.toFixed(0)} metrics/sec - ` +
          `ETA: ${Math.round(eta)}s`
      );

      // Save progress after each batch
      await this.saveProgress(name, batchNumber);
    }
  }

  complete(name: string, totalMetrics: number) {
    console.log(`✓ Completed migration: ${name} - ${totalMetrics} metrics inserted`);
    this.packageProgress.delete(name);
  }

  error(name: string, error: any) {
    console.error(`✗ Failed migration: ${name}`, error);
    this.packageProgress.delete(name);
  }

  async saveProgress(packageName: string, lastBatch: number) {
    // Serialize all saveProgress calls to prevent concurrent writes from losing data
    this.saveProgressLock = this.saveProgressLock.then(async () => {
      try {
        const progress = await this.loadProgress();
        progress[packageName] = lastBatch;
        await fs.writeFile(this.progressFile, JSON.stringify(progress, null, 2));
      } catch (error) {
        console.log(`Failed to save progress: ${error}`);
      }
    });
    await this.saveProgressLock;
  }

  async loadProgress(): Promise<Record<string, number>> {
    try {
      const data = await fs.readFile(this.progressFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  async clearProgress() {
    try {
      await fs.unlink(this.progressFile);
    } catch {
      // File doesn't exist, that's fine
    }
  }
}

export async function batchInsertClickhouse(
  metrics: EntityMetricEvent[],
  batchSize: number = 10000,
  dryRun: boolean = false
) {
  if (metrics.length === 0) return;

  if (dryRun) {
    console.log(`[DRY RUN] Would insert ${metrics.length} metrics`);
    return;
  }

  const batches = chunk(metrics, batchSize);

  // Use Promise.all for parallel inserts (ClickHouse can handle it)
  await Promise.all(
    batches.map((batch) =>
      clickhouse.insert({
        table: 'entityMetricEvents_testing',
        values: batch,
        format: 'JSONEachRow',
        clickhouse_settings: {
          async_insert: 1,
          wait_for_async_insert: 0,
        },
      })
    )
  );
}

export async function retryable<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  backoff = 1000
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.log(`Retry ${i + 1}/${maxRetries} after error:`, error);
      await new Promise((resolve) => setTimeout(resolve, backoff * (i + 1)));
    }
  }
  throw new Error('Should not reach here');
}
