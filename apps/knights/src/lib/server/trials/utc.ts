import { sql } from 'kysely';

export const utc = (date: Date) => sql<Date>`${date.toISOString()}::timestamp`;
