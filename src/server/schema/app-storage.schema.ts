import * as z from 'zod';

/**
 * An AppBlock id (`apb_…`) as the document store keys apps: the store's own app-id shape, so a
 * malformed id is a 400 here rather than a 500 from the store's context check.
 */
const appBlockIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

// Plain objects, not strict: the request pipeline's domain cap (`applyDomainFeature` in
// `trpc.ts`) can write `browsingLevel` into any object input before it is validated.
export const appStorageForAppSchema = z.object({ appBlockId: appBlockIdSchema });

export const emptyMyAppStorageSchema = z.object({
  appBlockId: appBlockIdSchema,
  /** Also delete the visible shared documents the user authored. Off unless asked for. */
  includeShared: z.boolean().default(false),
});

/** One page of the user's record export (`appStorage.exportMine`). */
export const exportMyAppRecordsSchema = z.object({
  /** The previous page's `nextCursor`; absent for the first page. */
  cursor: z.string().max(1024).nullish(),
  /** Records per page (`APP_RECORD_EXPORT_PAGE_MAX`). */
  limit: z.number().int().min(1).max(100).default(100),
});
