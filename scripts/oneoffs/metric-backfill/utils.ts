import fs from 'fs/promises';
import { chunk } from 'lodash-es';
import { createLogger } from '~/utils/logging';
import { clickhouse } from '~/server/clickhouse/client';
import type { EntityMetricEvent } from './types';

const logger = createLogger('metric-backfill');

export const CUTOFF_DATE = '2024-08-07 15:44:39.044';

export class ProgressTracker {
  private progressFile = './metric-backfill-progress.json';
  private packageProgress = new Map<
    string,
    { current: number; total: number; metrics: number; startTime: number }
  >();
  private metricsPerSecond: number[] = [];

  start(name: string) {
    logger.info(`Starting migration: ${name}`);
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
      logger.info(`${name}: ${total} batches to process`);
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

      const avgRate =
        this.metricsPerSecond.slice(-10).reduce((a, b) => a + b, 0) /
        Math.min(this.metricsPerSecond.length, 10);

      const remaining = progress.total - progress.current;
      const eta = remaining > 0 && avgRate > 0 ? remaining / (avgRate / 1000) : 0;

      logger.info(
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
    logger.info(`✓ Completed migration: ${name} - ${totalMetrics} metrics inserted`);
    this.packageProgress.delete(name);
  }

  error(name: string, error: any) {
    logger.error(`✗ Failed migration: ${name}`, error);
    this.packageProgress.delete(name);
  }

  async saveProgress(packageName: string, lastBatch: number) {
    try {
      const progress = await this.loadProgress();
      progress[packageName] = lastBatch;
      await fs.writeFile(this.progressFile, JSON.stringify(progress, null, 2));
    } catch (error) {
      logger.warn(`Failed to save progress: ${error}`);
    }
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
    logger.info(`[DRY RUN] Would insert ${metrics.length} metrics`);
    return;
  }

  const batches = chunk(metrics, batchSize);

  // Use Promise.all for parallel inserts (ClickHouse can handle it)
  await Promise.all(
    batches.map((batch) =>
      clickhouse.insert({
        table: 'entityMetricEvents',
        values: batch,
        format: 'JSONEachRow',
        clickhouse_settings: {
          async_insert: 1,
          wait_for_async_insert: 0,
          max_insert_block_size: 100000,
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
      logger.warn(`Retry ${i + 1}/${maxRetries} after error:`, error);
      await new Promise((resolve) => setTimeout(resolve, backoff * (i + 1)));
    }
  }
  throw new Error('Should not reach here');
}
