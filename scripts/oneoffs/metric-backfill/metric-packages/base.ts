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
