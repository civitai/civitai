/** Tuning for the apprenticeship core-set manager. */
export const CORESET = {
  flagMinAnswers: 20,
  flagFailureRate: 0.6,
  pageSize: 50,
} as const;

export type CoreSetConfig = { [K in keyof typeof CORESET]: number };

/** Which slice of a Trials list to read: a 1-based page, optionally only the item for one image. */
export type ListQuery = { page: number; imageId?: number };

export const FIRST_PAGE: ListQuery = { page: 1 };

/** `page` is the one actually read, clamped to the last page that has rows. */
export type ListPage<T> = { items: T[]; total: number; page: number };

/** Clamps the requested page to the pages that exist, so a stale link lands on the last one rather than on nothing. */
export function pageWindow(requested: number, total: number, pageSize: number) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(requested) || 1), last);
  return { page, offset: (page - 1) * pageSize, limit: pageSize };
}
