import type { SelectQueryBuilder } from 'kysely';

/** Tuning for the apprenticeship core-set manager. */
export const CORESET = {
  flagMinAnswers: 20,
  flagFailureRate: 0.6,
  pageSize: 50,
} as const;

export type CoreSetConfig = { [K in keyof typeof CORESET]: number };

export type ListQuery = {
  /** 1-based page. */
  page: number;
  imageId?: number;
};

export const FIRST_PAGE: ListQuery = { page: 1 };

export type ListPage<T> = { items: T[]; total: number; page: number };

/** Clamps to the last page so a stale link doesn't land on an empty one. */
export function pageWindow(requested: number, total: number, pageSize: number) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(requested) || 1), last);
  return { page, offset: (page - 1) * pageSize, limit: pageSize };
}

export async function countRows<DB, TB extends keyof DB>(
  query: SelectQueryBuilder<DB, TB, object>
): Promise<number> {
  const row = await query
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  return Number((row as { count: string }).count);
}
