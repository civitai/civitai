import { EntityMetricEvent as ExtEntityMetricEvent } from '@civitai/event-engine-common/types/metric-types';

export type EntityMetricEvent = ExtEntityMetricEvent;
export type Reactions = 'Cry' | 'Dislike' | 'Heart' | 'Laugh' | 'Like';
export type BatchRange = {
  start: number;
  end: number;
};

// Simplified query interfaces for easier mocking/testing
export type PgQuery = {
  query: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
};

export type ChQuery = {
  query: <T = any>(sql: string) => Promise<T[]>;
};

export type QueryContext = {
  pg: PgQuery;
  ch: ChQuery;
  dryRun: boolean;
};

export type ProcessorContext<TRow> = {
  pg: PgQuery;
  ch: ChQuery;
  rows: TRow[];
  addMetrics: (...metrics: (EntityMetricEvent | EntityMetricEvent[])[]) => void;
  dryRun: boolean;
};

export type MigrationPackage<TRow = any> = {
  queryBatchSize?: number; // Defaults to 1000
  range: (context: QueryContext) => Promise<BatchRange>;
  query: (context: QueryContext, range: BatchRange) => Promise<TRow[]>;
  processor: (context: ProcessorContext<TRow>) => Promise<void> | void;
};

export type MigrationParams = {
  concurrency?: number; // Number of concurrent batches (default: 1)
  insertBatchSize?: number; // ClickHouse insert batch size (default: 500)
  startFrom?: number; // Optional: start from specific batch
  packages?: string[]; // Optional: filter to specific packages by name
  dryRun?: boolean; // Don't insert, just count
  autoResume?: boolean; // Auto-resume from saved progress
  limitBatches?: number; // Optional: limit number of batches to process for testing
};
