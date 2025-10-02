import type { QueryContext, BatchRange } from '../types';
import { CUTOFF_DATE } from '../utils';

/**
 * Helper to create a standard ID-based range fetcher for Postgres tables
 */
export function createIdRangeFetcher(tableName: string, whereClause?: string) {
  return async ({ pg }: QueryContext): Promise<BatchRange> => {
    const where = whereClause ? `WHERE ${whereClause}` : '';
    const result = await pg.query<{ min: number; max: number }>(
      `SELECT MIN(id) as min, MAX(id) as max FROM "${tableName}" ${where}`
    );
    return { start: result[0]?.min ?? 0, end: result[0]?.max ?? 0 };
  };
}

/**
 * Helper to create a range fetcher based on a specific column for Postgres tables
 * Useful for tables with composite keys or non-standard primary keys
 */
export function createColumnRangeFetcher(
  tableName: string,
  columnName: string,
  whereClause?: string
) {
  return async ({ pg }: QueryContext): Promise<BatchRange> => {
    const where = whereClause ? `WHERE ${whereClause}` : '';
    const result = await pg.query<{ min: number; max: number }>(
      `SELECT MIN("${columnName}") as min, MAX("${columnName}") as max FROM "${tableName}" ${where}`
    );
    return { start: result[0]?.min ?? 0, end: result[0]?.max ?? 0 };
  };
}

/**
 * Helper to create a standard timestamp-based range fetcher for ClickHouse tables
 */
export function createTimestampRangeFetcher(
  tableName: string,
  timeColumn: string = 'time',
  whereClause?: string
) {
  return async ({ ch }: QueryContext): Promise<BatchRange> => {
    const where = whereClause ? `WHERE ${whereClause}` : '';
    const result = await ch.query<{ min: number; max: number }>(`
      SELECT
        toUnixTimestamp(MIN(${timeColumn})) as min,
        toUnixTimestamp(MAX(${timeColumn})) as max
      FROM ${tableName}
      ${where}
    `);
    return { start: result[0]?.min ?? 0, end: result[0]?.max ?? 0 };
  };
}

/**
 * Helper to create a standard timestamp-based range fetcher for PG tables
 */
export function createTimestampPgRangeFetcher(
  tableName: string,
  timeColumn: string = 'createdAt',
  whereClause?: string
) {
  return async ({ pg }: QueryContext): Promise<BatchRange> => {
    const where = whereClause ? `WHERE ${whereClause}` : '';
    const result = await pg.query<{ start: number; end: number }>(`
      SELECT
      extract(epoch from MIN("${timeColumn}")) as "start",
      extract(epoch from MAX("${timeColumn}")) as "end"
      FROM "${tableName}"
      ${where}
    `);
    if (!result || result.length === 0) return { start: 0, end: 0 };
    return result[0];
  };
}

export const TIME_FETCHER_BATCH = {
  day: 60*60*24,
  week: 60*60*24*7,
} as const;
